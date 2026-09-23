// @ts-check
/**
 * Configuration update validation with schema-based whitelisting.
 * Prevents arbitrary field injection from `{ ...config, ...req.body }`.
 */

const { validateConfigUpdate } = require('./config-validation');
const { PRESET_FIELD_RULES, LEGACY_PRESET_FIELD_RULES } = require('./regime-preset-contract');
const { REGIME_DEFAULTS, validateRegimeConfig, BACKUP_INTERVAL_BOUNDS, SENTINEL_POLL_INTERVAL_BOUNDS, SENTINEL_MAX_ALERTS_BOUNDS } = require('./config-utils');

const REGIME_ALLOWED_KEYS = new Set(Object.keys(REGIME_DEFAULTS));

/**
 * Drop stale or unknown regime fields while preserving the known subset.
 * Config editors round-trip stored objects, so unknown keys are ignored rather
 * than making an otherwise valid fund permanently unsaveable.
 * @param {unknown} update
 * @returns {{ value: Record<string, unknown>, droppedKeys: string[] }}
 */
const sanitizeRegimeConfig = (update) => {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return { value: {}, droppedKeys: [] };
  }

  /** @type {Record<string, unknown>} */
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
  tpMinPercent: ['tpMaxPercent'],
  tpMaxPercent: ['tpMinPercent'],
  macroDeclineThreshold: ['macroAccumulationThreshold'],
  macroAccumulationThreshold: ['macroDeclineThreshold', 'macroMarkupThreshold'],
  macroMarkupThreshold: ['macroAccumulationThreshold'],
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
 * @returns {import('./types').RegimeValidationResult & {droppedKeys: string[]}}
 */
const validateAndSanitizeRegimeConfig = (rawUpdate, currentConfig = {}) => {
  if (typeof rawUpdate !== 'object' || rawUpdate === null || Array.isArray(rawUpdate)) {
    return { valid: false, errors: ['regime update must be an object'], droppedKeys: [] };
  }
  const { value, droppedKeys } = sanitizeRegimeConfig(rawUpdate);

  const validationSubset = { ...value };
  for (const [key, partners] of Object.entries(REGIME_CROSS_FIELD_PARTNERS)) {
    if (validationSubset[key] === undefined) continue;
    for (const partner of partners) {
      if (!Object.prototype.hasOwnProperty.call(validationSubset, partner) && currentConfig?.[partner] !== undefined) {
        validationSubset[partner] = currentConfig[partner];
      }
    }
  }
  const result = validateRegimeConfig(validationSubset);
  if (result.valid === false) return { ...result, droppedKeys };

  // Partners are validation context, not requested updates.
  for (const key of Object.keys(result.value)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) delete result.value[key];
  }
  return { ...result, droppedKeys };
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
  consolidateAfterOrders: { type: 'number', min: 0 },
  consolidateInterval: { type: 'string', enum: ['never', 'daily', 'weekly'] },
};

// ── Aggressiveness preset schema ─────────────────────────────────
const AGGRESSIVENESS_SCHEMA = { ...PRESET_FIELD_RULES, ...LEGACY_PRESET_FIELD_RULES };

// ── Backup config schema ─────────────────────────────────────────
// Mirrors GLOBAL_DEFAULTS.backup (src/config-utils.js). Both scheduler
// intervals have a 5-minute floor — below the fastest interval the UI offers,
// and far above the `setInterval` clamp that turns a bad value into a ~1ms
// backup loop (#547).
// `maxBackups` must be a whole number in [1, 100] so a persisted 0/null/-1
// can never reach `pruneBackups` and delete every archive.
const BACKUP_CONFIG_SCHEMA = {
  enabled: { type: 'boolean' },
  intervalMs: { type: 'number', ...BACKUP_INTERVAL_BOUNDS },
  maxBackups: { type: 'number', min: 1, max: 100, integer: true },
  fundStateIntervalMs: { type: 'number', ...BACKUP_INTERVAL_BOUNDS },
  fundStateMaxBackups: { type: 'number', min: 1, max: 168, integer: true },
  includePriceCache: { type: 'boolean' },
};

// ── Sentinel config schema ───────────────────────────────────────
// Mirrors SENTINEL_DEFAULTS (src/config-utils.js). Only the flat top-level
// fields go through `validateConfigUpdate` here — `aiClassification`,
// `feeds`, and `keywords` are nested/array shapes it can't check, so
// `validateSentinelConfigUpdate` below covers those (issue #687).
const SENTINEL_CONFIG_SCHEMA = {
  enabled: { type: 'boolean' },
  pollIntervalMs: { type: 'number', ...SENTINEL_POLL_INTERVAL_BOUNDS, integer: true },
  maxAlerts: { type: 'number', ...SENTINEL_MAX_ALERTS_BOUNDS, integer: true },
};

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

const SENTINEL_KEYWORD_CATEGORIES = ['critical', 'warning', 'info'];

/**
 * Validate the `aiClassification`/`feeds`/`keywords` sub-objects of a
 * `PUT /api/sentinel/config` body. The route's top-level allowlist admits
 * these as a unit, but nothing checked their internal shape (issue #687):
 * a non-boolean `aiClassification.enabled`, an unbounded `maxPerHour`, a
 * non-array `feeds` (which also silently skipped the SSRF check), or a
 * `keywords` category that isn't an array of strings could all reach
 * `updateSentinelConfig` verbatim. Like `validateNotificationConfigUpdate`,
 * this only reports errors — it never strips fields — because the caller
 * still needs the raw sub-objects to run the SSRF check and to forward to
 * `updateSentinelConfig`'s shallow merge.
 * @param {unknown} updates - Sanitized (allowlisted top-level keys only) update body
 * @returns {{ errors: string[] }}
 */
const validateSentinelConfigUpdate = (updates) => {
  const errors = [];
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
    return { errors: ['update must be an object'] };
  }

  if (updates.aiClassification !== undefined) {
    const ai = updates.aiClassification;
    if (typeof ai !== 'object' || ai === null || Array.isArray(ai)) {
      errors.push('aiClassification: must be an object');
    } else {
      if (ai.enabled !== undefined && typeof ai.enabled !== 'boolean') {
        errors.push('aiClassification.enabled: expected boolean');
      }
      if (ai.maxPerHour !== undefined && !isIntegerInRange(ai.maxPerHour, 0, 1000)) {
        errors.push('aiClassification.maxPerHour: must be an integer between 0 and 1000');
      }
    }
  }

  if (updates.feeds !== undefined) {
    if (!Array.isArray(updates.feeds)) {
      errors.push('feeds: must be an array');
    } else if (updates.feeds.length > 50) {
      errors.push('feeds: must contain at most 50 entries');
    } else {
      updates.feeds.forEach((feed, i) => {
        if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
          errors.push(`feeds[${i}]: must be an object`);
          return;
        }
        if (typeof feed.name !== 'string') errors.push(`feeds[${i}].name: expected string`);
        if (typeof feed.url !== 'string') errors.push(`feeds[${i}].url: expected string`);
        if (feed.enabled !== undefined && typeof feed.enabled !== 'boolean') {
          errors.push(`feeds[${i}].enabled: expected boolean`);
        }
      });
    }
  }

  if (updates.keywords !== undefined) {
    const keywords = updates.keywords;
    if (typeof keywords !== 'object' || keywords === null || Array.isArray(keywords)) {
      errors.push('keywords: must be an object');
    } else {
      for (const category of SENTINEL_KEYWORD_CATEGORIES) {
        if (keywords[category] === undefined) continue;
        const list = keywords[category];
        if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
          errors.push(`keywords.${category}: must be an array of strings`);
        }
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
  BACKUP_CONFIG_SCHEMA,
  validateNotificationConfigUpdate,
  SENTINEL_CONFIG_SCHEMA,
  validateSentinelConfigUpdate,
};
