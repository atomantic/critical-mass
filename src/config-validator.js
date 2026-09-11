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

// ── Notification config validation ───────────────────────────────
const isIntegerInRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/**
 * Validate the subset of a `PUT /api/notifications/config` body that feeds
 * timer arithmetic (`notifier.js` `scheduleDailySummary`/`enqueue`) or the
 * quiet-hours gate, unlike `validateConfigUpdate` this only reports errors —
 * it never strips unknown fields — because `telegram`/`events` still need to
 * pass through untouched to the shallow-merge in `updateNotificationConfig`.
 * @param {unknown} updates - Request body (post mask round-trip guard)
 * @returns {{ errors: string[] }}
 */
const validateNotificationConfigUpdate = (updates) => {
  const errors = [];
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
    return { errors: ['update must be an object'] };
  }

  if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') {
    errors.push('enabled: expected boolean');
  }
  if (updates.dailySummaryHour !== undefined && !isIntegerInRange(updates.dailySummaryHour, 0, 23)) {
    errors.push('dailySummaryHour: must be an integer between 0 and 23');
  }
  if (updates.rateLimitMs !== undefined && !isIntegerInRange(updates.rateLimitMs, 1000, 300000)) {
    errors.push('rateLimitMs: must be an integer between 1000 and 300000');
  }

  if (updates.quietHours !== undefined) {
    const quietHours = updates.quietHours;
    if (typeof quietHours !== 'object' || quietHours === null || Array.isArray(quietHours)) {
      errors.push('quietHours: must be an object');
    } else {
      if (quietHours.enabled !== undefined && typeof quietHours.enabled !== 'boolean') {
        errors.push('quietHours.enabled: expected boolean');
      }
      if (quietHours.start !== undefined && !isIntegerInRange(quietHours.start, 0, 23)) {
        errors.push('quietHours.start: must be an integer between 0 and 23');
      }
      if (quietHours.end !== undefined && !isIntegerInRange(quietHours.end, 0, 23)) {
        errors.push('quietHours.end: must be an integer between 0 and 23');
      }
    }
  }

  return { errors };
};

module.exports = {
  validateConfigUpdate,
  sanitizeRegimeConfig,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
  validateNotificationConfigUpdate,
};
