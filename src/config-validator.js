// @ts-check
/**
 * Configuration update validation with schema-based whitelisting.
 * Prevents arbitrary field injection from `{ ...config, ...req.body }`.
 */

const { validateConfigUpdate } = require('./config-validation');
const { PRESET_FIELD_RULES, LEGACY_PRESET_FIELD_RULES } = require('./regime-preset-contract');
const { REGIME_DEFAULTS, validateRegimeConfig } = require('./config-utils');

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

// Cross-field regime pairs whose validity depends on each other (e.g. a TP
// floor must stay below the TP ceiling). A partial update touching only one
// half of a pair must still be checked against the *other* half's real
// current value, or a lone `tpMinPercent` bump would be validated against
// `undefined` instead of the fund's actual `tpMaxPercent`.
const REGIME_CROSS_FIELD_PARTNERS = {
  tpMinPercent: 'tpMaxPercent',
  tpMaxPercent: 'tpMinPercent',
  macroDeclineThreshold: 'macroAccumulationThreshold',
  macroAccumulationThreshold: 'macroMarkupThreshold',
  macroMarkupThreshold: 'macroAccumulationThreshold',
};

/**
 * Sanitize + value-validate a nested `regime` config update in one shared step.
 * Every entry point that can persist into `regime.*` — the dedicated
 * `PUT /api/:exchange/regime/config`, the full-config `PUT /api/:exchange/config`
 * and legacy `PUT /api/config`, and fund creation's regime seed — must route
 * through this before persistence or IPC. Without it, a value rejected by one
 * save surface (e.g. `maxDrawdownPercent: 999`, outside the documented 10-30
 * range) could still be persisted and forwarded to the live engine through
 * another, defeating a safety limit it's supposed to enforce (issue #452).
 *
 * Unknown keys are DROPPED, not rejected — `sanitizeRegimeConfig`'s documented
 * round-trip contract, which keeps a fund whose stored regime block carries a
 * stale/removed key permanently saveable. Known values are then checked with
 * `validateRegimeConfig`, filling in `currentConfig`'s value for any
 * cross-field partner this update didn't touch, so partial updates are
 * validated against the fund's real current state.
 *
 * @param {unknown} rawUpdate - Untrusted nested regime object from a request body
 * @param {Object} [currentConfig] - The fund's current (defaults-merged) regime config, for cross-field checks
 * @returns {{ value: Object, droppedKeys: string[], valid: boolean, errors: string[] }}
 */
const validateAndSanitizeRegimeConfig = (rawUpdate, currentConfig = {}) => {
  const { value, droppedKeys } = sanitizeRegimeConfig(rawUpdate);

  const validationSubset = { ...value };
  for (const [key, partner] of Object.entries(REGIME_CROSS_FIELD_PARTNERS)) {
    if (validationSubset[key] !== undefined && validationSubset[partner] === undefined) {
      validationSubset[partner] = currentConfig?.[partner];
    }
  }
  const { valid, errors } = validateRegimeConfig(validationSubset);

  return { value, droppedKeys, valid, errors };
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
  validateAndSanitizeRegimeConfig,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
  validateNotificationConfigUpdate,
};
