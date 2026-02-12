// @ts-check
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  INTERVAL_DEFINITIONS,
  CONSOLIDATION_INTERVALS,
  getIntervalConfig,
  getNextExecutionTime,
  getRunIdentifier,
  hasRunThisInterval,
  normalizeConfig,
  getIntervalAmount,
  formatInterval,
  getTimeUntilNext,
  getConsolidationRunId,
  shouldRunConsolidation,
} = require('../src/interval-utils');

// ============================================================================
// INTERVAL_DEFINITIONS constant
// ============================================================================
describe('INTERVAL_DEFINITIONS', () => {
  it('contains all expected interval types', () => {
    const expected = ['1min', '5min', '10min', '30min', '1hour', '4hour', 'daily'];
    assert.deepStrictEqual(Object.keys(INTERVAL_DEFINITIONS), expected);
  });

  it('has correct ms values for each interval', () => {
    assert.equal(INTERVAL_DEFINITIONS['1min'].ms, 60_000);
    assert.equal(INTERVAL_DEFINITIONS['5min'].ms, 300_000);
    assert.equal(INTERVAL_DEFINITIONS['10min'].ms, 600_000);
    assert.equal(INTERVAL_DEFINITIONS['30min'].ms, 1_800_000);
    assert.equal(INTERVAL_DEFINITIONS['1hour'].ms, 3_600_000);
    assert.equal(INTERVAL_DEFINITIONS['4hour'].ms, 14_400_000);
    assert.equal(INTERVAL_DEFINITIONS['daily'].ms, 86_400_000);
  });

  it('has correct granularity and aggregateFactor for aggregated intervals', () => {
    // 10min uses 5-min candles aggregated x2
    assert.equal(INTERVAL_DEFINITIONS['10min'].granularity, 300);
    assert.equal(INTERVAL_DEFINITIONS['10min'].aggregateFactor, 2);
    // 4hour uses 1-hour candles aggregated x4
    assert.equal(INTERVAL_DEFINITIONS['4hour'].granularity, 3600);
    assert.equal(INTERVAL_DEFINITIONS['4hour'].aggregateFactor, 4);
  });
});

// ============================================================================
// getIntervalConfig
// ============================================================================
describe('getIntervalConfig', () => {
  it('returns correct config for a known interval type', () => {
    const config = getIntervalConfig('1hour');
    assert.equal(config.ms, 3_600_000);
    assert.equal(config.label, '1 Hour');
    assert.equal(config.granularity, 3600);
    assert.equal(config.aggregateFactor, 1);
  });

  it('falls back to daily for an unknown interval type', () => {
    const config = getIntervalConfig('unknown_garbage');
    assert.equal(config.ms, INTERVAL_DEFINITIONS['daily'].ms);
    assert.equal(config.label, 'Daily');
  });
});

// ============================================================================
// getNextExecutionTime
// ============================================================================
describe('getNextExecutionTime', () => {
  it('returns a timestamp strictly in the future for non-daily intervals', () => {
    const now = Date.now();
    const next = getNextExecutionTime('1hour');
    assert.ok(next > now, `next (${next}) should be > now (${now})`);
  });

  it('aligns non-daily intervals to interval boundaries', () => {
    const next = getNextExecutionTime('1hour');
    // The result should be evenly divisible by the 1-hour ms value
    assert.equal(next % INTERVAL_DEFINITIONS['1hour'].ms, 0);
  });

  it('returns a time aligned to 10:00 UTC for daily interval', () => {
    const next = getNextExecutionTime('daily');
    const d = new Date(next);
    assert.equal(d.getUTCHours(), 10);
    assert.equal(d.getUTCMinutes(), 0);
    assert.equal(d.getUTCSeconds(), 0);
    assert.equal(d.getUTCMilliseconds(), 0);
  });

  it('daily next execution is always in the future', () => {
    const now = Date.now();
    const next = getNextExecutionTime('daily');
    assert.ok(next > now);
  });

  it('5-minute interval aligns to 5-minute boundary', () => {
    const next = getNextExecutionTime('5min');
    assert.equal(next % INTERVAL_DEFINITIONS['5min'].ms, 0);
  });
});

// ============================================================================
// getRunIdentifier
// ============================================================================
describe('getRunIdentifier', () => {
  it('returns a string prefixed with the interval type', () => {
    const id = getRunIdentifier('10min');
    assert.ok(id.startsWith('10min-'));
  });

  it('returns the same identifier within the same interval window', () => {
    // Two calls in rapid succession should produce the same ID
    const id1 = getRunIdentifier('1hour');
    const id2 = getRunIdentifier('1hour');
    assert.equal(id1, id2);
  });

  it('produces different identifiers for different interval types at the same time', () => {
    const id5 = getRunIdentifier('5min');
    const id1h = getRunIdentifier('1hour');
    assert.notEqual(id5, id1h);
  });

  it('identifier contains a numeric interval index', () => {
    const id = getRunIdentifier('1hour');
    const parts = id.split('-');
    const index = Number(parts[parts.length - 1]);
    assert.ok(Number.isFinite(index));
    assert.ok(index > 0);
  });
});

// ============================================================================
// hasRunThisInterval
// ============================================================================
describe('hasRunThisInterval', () => {
  it('returns true when lastRunId matches current interval', () => {
    const currentId = getRunIdentifier('1hour');
    assert.equal(hasRunThisInterval(currentId, '1hour'), true);
  });

  it('returns false when lastRunId is null', () => {
    assert.equal(hasRunThisInterval(null, '1hour'), false);
  });

  it('returns false when lastRunId is from a different interval window', () => {
    // Fabricate an old ID with a decremented index
    const currentId = getRunIdentifier('5min');
    const parts = currentId.split('-');
    const oldIndex = Number(parts[parts.length - 1]) - 1;
    const oldId = `5min-${oldIndex}`;
    assert.equal(hasRunThisInterval(oldId, '5min'), false);
  });
});

// ============================================================================
// normalizeConfig
// ============================================================================
describe('normalizeConfig', () => {
  it('uses intervalsToSpread when provided', () => {
    const config = normalizeConfig({ intervalsToSpread: 30, intervalType: '1hour' });
    assert.equal(config.intervalsToSpread, 30);
    assert.equal(config.intervalType, '1hour');
  });

  it('falls back to daysToSpread for backwards compatibility', () => {
    const config = normalizeConfig({ daysToSpread: 45 });
    assert.equal(config.intervalsToSpread, 45);
  });

  it('defaults to 60 when neither intervalsToSpread nor daysToSpread is set', () => {
    const config = normalizeConfig({});
    assert.equal(config.intervalsToSpread, 60);
  });

  it('defaults intervalType to daily when not provided', () => {
    const config = normalizeConfig({});
    assert.equal(config.intervalType, 'daily');
  });

  it('preserves other config properties via spread', () => {
    const config = normalizeConfig({ totalAllocation: 5000, intervalType: '4hour', intervalsToSpread: 10 });
    assert.equal(config.totalAllocation, 5000);
    assert.equal(config.intervalType, '4hour');
    assert.equal(config.intervalsToSpread, 10);
  });

  it('prefers intervalsToSpread over daysToSpread when both are present', () => {
    const config = normalizeConfig({ intervalsToSpread: 20, daysToSpread: 90 });
    assert.equal(config.intervalsToSpread, 20);
  });
});

// ============================================================================
// getIntervalAmount
// ============================================================================
describe('getIntervalAmount', () => {
  it('calculates correct amount per interval', () => {
    const amount = getIntervalAmount({ totalAllocation: 6000, intervalsToSpread: 30, intervalType: '1hour' });
    assert.equal(amount, 200);
  });

  it('uses default intervalsToSpread (60) when not provided', () => {
    const amount = getIntervalAmount({ totalAllocation: 6000 });
    assert.equal(amount, 100);
  });

  it('handles fractional results', () => {
    const amount = getIntervalAmount({ totalAllocation: 1000, intervalsToSpread: 3, intervalType: 'daily' });
    assert.ok(Math.abs(amount - 333.3333333333333) < 0.0001);
  });
});

// ============================================================================
// formatInterval
// ============================================================================
describe('formatInterval', () => {
  it('returns human-readable labels for all known types', () => {
    assert.equal(formatInterval('1min'), '1 Minute');
    assert.equal(formatInterval('5min'), '5 Minutes');
    assert.equal(formatInterval('10min'), '10 Minutes');
    assert.equal(formatInterval('30min'), '30 Minutes');
    assert.equal(formatInterval('1hour'), '1 Hour');
    assert.equal(formatInterval('4hour'), '4 Hours');
    assert.equal(formatInterval('daily'), 'Daily');
  });

  it('returns Daily label for unknown interval type (fallback)', () => {
    assert.equal(formatInterval('nonexistent'), 'Daily');
  });
});

// ============================================================================
// getTimeUntilNext
// ============================================================================
describe('getTimeUntilNext', () => {
  it('returns a positive ms value', () => {
    const { ms } = getTimeUntilNext('1hour');
    assert.ok(ms > 0, `ms should be positive: ${ms}`);
  });

  it('returns a formatted string', () => {
    const { formatted } = getTimeUntilNext('1hour');
    assert.equal(typeof formatted, 'string');
    assert.ok(formatted.length > 0);
  });

  it('formatted string contains time units (h/m/s)', () => {
    const { formatted } = getTimeUntilNext('daily');
    // Daily waits can be hours or minutes
    assert.ok(/\d+[hms]/.test(formatted), `Expected time units in: ${formatted}`);
  });

  it('ms value does not exceed the interval length', () => {
    const { ms } = getTimeUntilNext('5min');
    assert.ok(ms <= INTERVAL_DEFINITIONS['5min'].ms, `ms (${ms}) should be <= interval (${INTERVAL_DEFINITIONS['5min'].ms})`);
  });
});

// ============================================================================
// CONSOLIDATION_INTERVALS
// ============================================================================
describe('CONSOLIDATION_INTERVALS', () => {
  it('contains never, daily, and weekly entries', () => {
    assert.deepStrictEqual(Object.keys(CONSOLIDATION_INTERVALS).sort(), ['daily', 'never', 'weekly']);
  });

  it('never has ms of 0', () => {
    assert.equal(CONSOLIDATION_INTERVALS['never'].ms, 0);
  });

  it('weekly ms is 7x daily ms', () => {
    assert.equal(CONSOLIDATION_INTERVALS['weekly'].ms, 7 * CONSOLIDATION_INTERVALS['daily'].ms);
  });
});

// ============================================================================
// getConsolidationRunId
// ============================================================================
describe('getConsolidationRunId', () => {
  it('returns a string prefixed with consolidate-{type}-', () => {
    const id = getConsolidationRunId('daily');
    assert.ok(id.startsWith('consolidate-daily-'));
  });

  it('returns different IDs for daily vs weekly', () => {
    const dailyId = getConsolidationRunId('daily');
    const weeklyId = getConsolidationRunId('weekly');
    assert.notEqual(dailyId, weeklyId);
  });

  it('falls back to daily ms for unknown consolidation type', () => {
    const id = getConsolidationRunId('unknown_type');
    // Should still produce a valid string (uses daily fallback)
    assert.ok(id.startsWith('consolidate-unknown_type-'));
    assert.ok(id.length > 'consolidate-unknown_type-'.length);
  });
});

// ============================================================================
// shouldRunConsolidation
// ============================================================================
describe('shouldRunConsolidation', () => {
  it('returns false when consolidateInterval is never', () => {
    assert.equal(shouldRunConsolidation(null, 'never'), false);
  });

  it('returns false when consolidateInterval is falsy', () => {
    assert.equal(shouldRunConsolidation(null, undefined), false);
    assert.equal(shouldRunConsolidation(null, ''), false);
    assert.equal(shouldRunConsolidation(null, null), false);
  });

  it('returns true when lastConsolidationId is null (first run)', () => {
    assert.equal(shouldRunConsolidation(null, 'daily'), true);
  });

  it('returns false when lastConsolidationId matches current window', () => {
    const currentId = getConsolidationRunId('weekly');
    assert.equal(shouldRunConsolidation(currentId, 'weekly'), false);
  });

  it('returns true when lastConsolidationId is from a previous window', () => {
    const currentId = getConsolidationRunId('daily');
    const parts = currentId.split('-');
    const oldIndex = Number(parts[parts.length - 1]) - 1;
    const oldId = `consolidate-daily-${oldIndex}`;
    assert.equal(shouldRunConsolidation(oldId, 'daily'), true);
  });
});
