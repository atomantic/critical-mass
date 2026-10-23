// @ts-check
/**
 * Aggressiveness preset settings.
 * Persistence stays in config-utils; injected readers/writers avoid a runtime
 * back-edge and keep every settings update on the shared config write lock.
 */

const { DEFAULT_AGGRESSIVENESS_PRESETS, PRESET_FIELD_RULES } = require('../regime-preset-contract');

/** Create the settings service using the facade-owned config operations. */
const createAggressivenessSettings = ({ loadConfig, mutateConfig, computeDiff, configLogger }) => {
  /**
   * Whether a stored preset value satisfies the shared preset bounds. Keys with
   * no rule (e.g. historical schema-only fields) are passed through untouched.
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  const isPresetValueInBounds = (key, value) => {
    const rule = PRESET_FIELD_RULES[key];
    if (!rule) return true;
    return typeof value === 'number' && Number.isFinite(value) && value >= rule.min && value <= rule.max;
  };

  /**
   * Get aggressiveness presets (user-customized merged with defaults).
   * Stored values outside the current preset bounds (e.g. saved under the looser
   * pre-#323 limits) are reported and skipped in favor of the shipped default,
   * so the editor never offers a value the fund-config save would reject.
   * @returns {Object} Presets keyed by level id
   */
  const getAggressivenessPresets = () => {
    const config = loadConfig();
    const saved = config.global?.aggressivenessPresets || {};
    const merged = {};
    for (const level of Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS)) {
      const valid = {};
      for (const [key, value] of Object.entries(saved[level] || {})) {
        if (isPresetValueInBounds(key, value)) {
          valid[key] = value;
        } else {
          configLogger.warn('⚠️ [config] Ignoring out-of-range stored aggressiveness preset value; using default', { level, key, value });
        }
      }
      merged[level] = { ...DEFAULT_AGGRESSIVENESS_PRESETS[level], ...valid };
    }
    return merged;
  };

  /**
   * Update aggressiveness presets. Only keys that differ from the shipped
   * defaults (or were already explicitly stored) are persisted, so later changes
   * to default preset values still reach installs that edited one level.
   * @param {Object} updates - Presets keyed by level id with partial param overrides
   * @returns {Object} Updated full configuration (global.aggressivenessPresets holds the effective values)
   */
  const updateAggressivenessPresets = (updates) => {
    const effective = {};
    const config = mutateConfig((draft) => {
      const current = draft.global?.aggressivenessPresets || {};

      const overrides = {};
      for (const level of Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS)) {
        const defaults = DEFAULT_AGGRESSIVENESS_PRESETS[level];
        const requested = { ...current[level], ...updates[level] };
        effective[level] = { ...defaults, ...requested };
        // Previously pinned keys survive even when equal to the default; keys merely
        // echoed back by the editor at their default value are not pinned.
        const diff = computeDiff(defaults, requested, current[level] || {});
        if (Object.keys(diff).length) overrides[level] = diff;
      }

      draft.global = draft.global || {};
      draft.global.aggressivenessPresets = overrides;
    });
    // Return effective values for callers; the file holds only the overrides.
    config.global.aggressivenessPresets = effective;
    return config;
  };

  return { getAggressivenessPresets, updateAggressivenessPresets };
};

module.exports = { createAggressivenessSettings };
