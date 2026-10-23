// @ts-check
/**
 * Sentinel settings.
 * Persistence stays in config-utils; injected readers/writers avoid a runtime
 * back-edge and keep every settings update on the shared config write lock.
 */

/**
 * Default sentinel configuration
 */
const SENTINEL_DEFAULTS = {
  enabled: false,
  pollIntervalMs: 300000,
  maxAlerts: 200,
  aiClassification: { enabled: true, maxPerHour: 10 },
  feeds: [
    { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', enabled: true },
    { name: 'CNBC Economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', enabled: true },
  ],
  keywords: {
    critical: ['rate cut', 'rate hike', 'emergency', 'FOMC decision', 'quantitative easing', 'quantitative tightening', 'war declared', 'nuclear'],
    warning: ['FOMC', 'inflation', 'CPI', 'unemployment', 'tariff', 'sanctions', 'Iran', 'geopolitical', 'fed funds'],
    info: ['fed speech', 'treasury', 'GDP', 'economic data'],
  },
};

// Same "~1ms setInterval" clamp risk as BACKUP_INTERVAL_BOUNDS (#547): a
// 60s floor keeps a bad pollIntervalMs from hammering every configured RSS
// feed back-to-back, a 24h ceiling keeps it from effectively never running.
// Shared with SENTINEL_CONFIG_SCHEMA (config-validator.js) so the PUT-time
// bound and the on-disk clamp below never drift apart (issue #687).
const SENTINEL_POLL_INTERVAL_BOUNDS = { min: 60000, max: 86400000 };
// alerts.slice(-maxAlerts) (sentinel-service.js) needs a small positive
// integer — 0/negative/non-finite would keep the wrong tail (or none).
const SENTINEL_MAX_ALERTS_BOUNDS = { min: 1, max: 5000 };

/** Create the settings service using the facade-owned config operations. */
const createSentinelSettings = ({ loadConfig, mutateConfig }) => {
  /**
   * Get sentinel configuration with defaults
   * @returns {Object} Sentinel config
   */
  const getSentinelConfig = () => {
    const config = loadConfig();
    const sentinel = config.global?.sentinel || {};
    const result = {
      ...SENTINEL_DEFAULTS,
      ...sentinel,
      aiClassification: { ...SENTINEL_DEFAULTS.aiClassification, ...sentinel.aiClassification },
      keywords: { ...SENTINEL_DEFAULTS.keywords, ...sentinel.keywords },
      feeds: sentinel.feeds || SENTINEL_DEFAULTS.feeds,
    };
    // Files edited by hand (or saved before #687 added PUT-time validation)
    // bypass the API schema. Never hand an out-of-range value to the poll
    // timer or the alert-history trim — clamp back to the default the same
    // way getBackupConfig does for the backup timers.
    if (!Number.isFinite(result.pollIntervalMs) || result.pollIntervalMs < SENTINEL_POLL_INTERVAL_BOUNDS.min || result.pollIntervalMs > SENTINEL_POLL_INTERVAL_BOUNDS.max) {
      result.pollIntervalMs = SENTINEL_DEFAULTS.pollIntervalMs;
    }
    if (!Number.isInteger(result.maxAlerts) || result.maxAlerts < SENTINEL_MAX_ALERTS_BOUNDS.min || result.maxAlerts > SENTINEL_MAX_ALERTS_BOUNDS.max) {
      result.maxAlerts = SENTINEL_DEFAULTS.maxAlerts;
    }
    return result;
  };

  /**
   * Update sentinel configuration
   * @param {Object} updates - Sentinel config updates
   * @returns {Object} Updated full configuration
   */
  const updateSentinelConfig = (updates) => mutateConfig((config) => {
    const current = config.global?.sentinel || {};

    config.global = config.global || {};
    config.global.sentinel = {
      ...current,
      ...updates,
      aiClassification: updates.aiClassification
        ? { ...current.aiClassification, ...updates.aiClassification }
        : current.aiClassification,
      keywords: updates.keywords
        ? { ...current.keywords, ...updates.keywords }
        : current.keywords,
    };
  });

  return { getSentinelConfig, updateSentinelConfig };
};

module.exports = { createSentinelSettings, SENTINEL_DEFAULTS, SENTINEL_POLL_INTERVAL_BOUNDS, SENTINEL_MAX_ALERTS_BOUNDS };
