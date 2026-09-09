// @ts-check
/**
 * Configuration update validation with schema-based whitelisting.
 * Prevents arbitrary field injection from `{ ...config, ...req.body }`.
 */

const { validateConfigUpdate } = require('./config-validation');
const { PRESET_FIELD_RULES, LEGACY_PRESET_FIELD_RULES } = require('./regime-preset-contract');
const { REGIME_DEFAULTS } = require('./config-utils');

const REGIME_ALLOWED_KEYS = new Set(Object.keys(REGIME_DEFAULTS));

/**
 * Drop stale or unknown regime fields while preserving the known subset.
 * Config editors round-trip stored objects, so unknown keys are ignored rather
 * than making an otherwise valid fund permanently unsaveable.
 * @param {unknown} update
 * @returns {{ value: Object, droppedKeys: string[] }}
 */
const sanitizeRegimeConfig = (update) => {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return { value: {}, droppedKeys: [] };
  }

  const value = {};
  const droppedKeys = [];
  for (const [key, fieldValue] of Object.entries(update)) {
    if (REGIME_ALLOWED_KEYS.has(key)) value[key] = fieldValue;
    else droppedKeys.push(key);
  }
  return { value, droppedKeys };
};

// ── Exchange config schema ───────────────────────────────────────
const EXCHANGE_CONFIG_SCHEMA = {
  enabled: { type: 'boolean' },
  dryRun: { type: 'boolean' },
  productId: { type: 'string' },
  dcaStrategy: { type: 'string', enum: ['fixed', 'fibonacci'] },
  intervalType: { type: 'string' },
  amount: { type: 'number', min: 0 },
  totalAllocation: { type: 'number', min: 0 },
  intervalsToSpread: { type: 'number', min: 1 },
  sellMarkupPercent: { type: 'number', min: 0 },
  holdbackPercent: { type: 'number', min: 0, max: 100 },
  minOrderSize: { type: 'number', min: 0 },
  maxBuyPrice: { type: 'number', min: 0 },
  fibBaseAmount: { type: 'number', min: 0 },
};

// ── Aggressiveness preset schema ─────────────────────────────────
const AGGRESSIVENESS_SCHEMA = { ...PRESET_FIELD_RULES, ...LEGACY_PRESET_FIELD_RULES };

module.exports = {
  validateConfigUpdate,
  sanitizeRegimeConfig,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
};
