// @ts-check
/**
 * Backup settings.
 * Persistence stays in config-utils; injected readers/writers avoid a runtime
 * back-edge and keep every settings update on the shared config write lock.
 */

// Node clamps delays above its signed 32-bit limit to 1 ms.
const BACKUP_INTERVAL_BOUNDS = { min: 300000, max: 2147483647 };

/** Create the settings service using the facade-owned config operations. */
const createBackupSettings = ({ loadConfig, mutateConfig, globalDefaults }) => {
  /**
   * Get backup configuration with defaults
   * @returns {Object} Backup config
   */
  const getBackupConfig = () => {
    const config = loadConfig();
    const backup = config.global?.backup || {};
    const result = {
      ...globalDefaults.backup,
      ...backup,
    };
    // Files edited by hand bypass the API schema. Never hand an unsafe delay
    // to either backup timer, which could churn through the retained history.
    for (const key of ['intervalMs', 'fundStateIntervalMs']) {
      const value = result[key];
      if (!Number.isFinite(value) || value < BACKUP_INTERVAL_BOUNDS.min || value > BACKUP_INTERVAL_BOUNDS.max) {
        result[key] = globalDefaults.backup[key];
      }
    }
    return result;
  };

  /**
   * Update backup configuration
   * @param {Object} updates - Backup config updates
   * @returns {Object} Updated full configuration
   */
  const updateBackupConfig = (updates) => mutateConfig((config) => {
    const current = config.global?.backup || {};

    config.global = config.global || {};
    config.global.backup = {
      ...globalDefaults.backup,
      ...current,
      ...updates,
    };
  });

  return { getBackupConfig, updateBackupConfig };
};

module.exports = { createBackupSettings, BACKUP_INTERVAL_BOUNDS };
