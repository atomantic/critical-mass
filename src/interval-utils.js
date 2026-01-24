/**
 * Interval utilities for granular time-based trading
 * Supports 10-minute, 1-hour, 4-hour, and daily intervals
 */

// Interval definitions with ms values and Coinbase API granularity
const INTERVAL_DEFINITIONS = {
  '5min': {
    ms: 5 * 60 * 1000,
    label: '5 Minutes',
    granularity: 300,  // FIVE_MINUTE candles
    aggregateFactor: 1
  },
  '10min': {
    ms: 10 * 60 * 1000,
    label: '10 Minutes',
    granularity: 300,  // Use 5-min candles, aggregate to 10-min
    aggregateFactor: 2
  },
  '30min': {
    ms: 30 * 60 * 1000,
    label: '30 Minutes',
    granularity: 1800,  // THIRTY_MINUTE candles
    aggregateFactor: 1
  },
  '1hour': {
    ms: 60 * 60 * 1000,
    label: '1 Hour',
    granularity: 3600,
    aggregateFactor: 1
  },
  '4hour': {
    ms: 4 * 60 * 60 * 1000,
    label: '4 Hours',
    granularity: 3600,  // Use 1-hour candles, aggregate to 4-hour
    aggregateFactor: 4
  },
  'daily': {
    ms: 24 * 60 * 60 * 1000,
    label: 'Daily',
    granularity: 86400,
    aggregateFactor: 1
  }
};

/**
 * Get interval config by type
 * @param {string} intervalType - One of: 10min, 1hour, 4hour, daily
 * @returns {Object} Interval configuration
 */
const getIntervalConfig = (intervalType) =>
  INTERVAL_DEFINITIONS[intervalType] || INTERVAL_DEFINITIONS['daily'];

/**
 * Calculate next execution time aligned to interval boundaries
 * @param {string} intervalType - Interval type
 * @param {number} lastRunTimestamp - Optional last run timestamp
 * @returns {number} Next execution timestamp in ms
 */
const getNextExecutionTime = (intervalType, lastRunTimestamp = null) => {
  const now = Date.now();
  const { ms } = getIntervalConfig(intervalType);

  // For daily, align to 10 AM UTC
  if (intervalType === 'daily') {
    const next = new Date(now);
    next.setUTCHours(10, 0, 0, 0);
    if (next.getTime() <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime();
  }

  // For other intervals, align to interval boundaries
  const intervalStart = Math.floor(now / ms) * ms;
  const nextSlot = intervalStart + ms;
  return nextSlot;
};

/**
 * Generate unique run identifier for an interval slot
 * Prevents duplicate runs within the same interval
 * @param {string} intervalType - Interval type
 * @returns {string} Unique run identifier
 */
const getRunIdentifier = (intervalType) => {
  const now = Date.now();
  const { ms } = getIntervalConfig(intervalType);
  const intervalIndex = Math.floor(now / ms);
  return `${intervalType}-${intervalIndex}`;
};

/**
 * Check if current interval was already executed
 * @param {string} lastRunId - Last run identifier from state
 * @param {string} intervalType - Interval type
 * @returns {boolean} True if already ran this interval
 */
const hasRunThisInterval = (lastRunId, intervalType) => {
  const currentId = getRunIdentifier(intervalType);
  return lastRunId === currentId;
};

/**
 * Normalize config for backwards compatibility
 * Handles both old (daysToSpread) and new (intervalsToSpread) formats
 * @param {Object} config - Configuration object
 * @returns {Object} Normalized configuration
 */
const normalizeConfig = (config) => ({
  ...config,
  intervalsToSpread: config.intervalsToSpread || config.daysToSpread || 60,
  intervalType: config.intervalType || 'daily'
});

/**
 * Get interval amount (allocation per interval)
 * @param {Object} config - Configuration object
 * @returns {number} Amount per interval
 */
const getIntervalAmount = (config) => {
  const normalized = normalizeConfig(config);
  return normalized.totalAllocation / normalized.intervalsToSpread;
};

/**
 * Format interval for display
 * @param {string} intervalType - Interval type
 * @returns {string} Human-readable label
 */
const formatInterval = (intervalType) => {
  const config = getIntervalConfig(intervalType);
  return config.label;
};

/**
 * Get time until next execution
 * @param {string} intervalType - Interval type
 * @returns {{ms: number, formatted: string}} Time until next run
 */
const getTimeUntilNext = (intervalType) => {
  const nextTime = getNextExecutionTime(intervalType);
  const ms = nextTime - Date.now();

  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((ms % (60 * 1000)) / 1000);

  let formatted;
  if (hours > 0) {
    formatted = `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    formatted = `${minutes}m ${seconds}s`;
  } else {
    formatted = `${seconds}s`;
  }

  return { ms, formatted };
};

module.exports = {
  INTERVAL_DEFINITIONS,
  getIntervalConfig,
  getNextExecutionTime,
  getRunIdentifier,
  hasRunThisInterval,
  normalizeConfig,
  getIntervalAmount,
  formatInterval,
  getTimeUntilNext,
};
