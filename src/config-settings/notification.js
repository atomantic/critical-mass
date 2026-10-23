// @ts-check
/**
 * Notification settings.
 * Persistence stays in config-utils; injected readers/writers avoid a runtime
 * back-edge and keep every settings update on the shared config write lock.
 */

/**
 * Default notification configuration
 */
const NOTIFICATION_DEFAULTS = {
  enabled: false,
  telegram: { botToken: '', chatId: '' },
  events: {
    buy_filled: true,
    entry_filled: true,
    tp_filled: true,
    regime_change: true,
    flash_move: true,
    safe_mode: true,
    active_mode: true,
    cap_reached: true,
    cycle_reset: true,
    error: true,
    sell_placed: false,
    tp_placed: false,
    spread_pause: false,
    depth_pause: false,
    regime_hourly: false,
    aggressiveness_suggestion: false,
    orders_consolidated: false,
  },
  rateLimitMs: 5000,
  dailySummaryHour: 20,
  quietHours: { enabled: false, start: 23, end: 7 },
};

/** Create the settings service using the facade-owned config operations. */
const createNotificationSettings = ({ loadConfig, mutateConfig }) => {
  /**
   * Get notification configuration with defaults
   * @returns {Object} Notification config
   */
  const getNotificationConfig = () => {
    const config = loadConfig();
    const notif = config.global?.notifications || {};
    return {
      ...NOTIFICATION_DEFAULTS,
      ...notif,
      telegram: { ...NOTIFICATION_DEFAULTS.telegram, ...notif.telegram },
      events: { ...NOTIFICATION_DEFAULTS.events, ...notif.events },
      quietHours: { ...NOTIFICATION_DEFAULTS.quietHours, ...notif.quietHours },
    };
  };

  /**
   * Update notification configuration
   * @param {Object} updates - Notification config updates
   * @returns {Object} Updated full configuration
   */
  const updateNotificationConfig = (updates) => mutateConfig((config) => {
    const current = config.global?.notifications || {};

    config.global = config.global || {};
    config.global.notifications = {
      ...current,
      ...updates,
      telegram: updates.telegram
        ? { ...current.telegram, ...updates.telegram }
        : current.telegram,
      events: updates.events
        ? { ...current.events, ...updates.events }
        : current.events,
      quietHours: updates.quietHours
        ? { ...current.quietHours, ...updates.quietHours }
        : current.quietHours,
    };
  });

  return { getNotificationConfig, updateNotificationConfig };
};

module.exports = { createNotificationSettings, NOTIFICATION_DEFAULTS };
