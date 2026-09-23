// @ts-check
/**
 * Configuration update validation with schema-based whitelisting.
 * Prevents arbitrary field injection from `{ ...config, ...req.body }`.
 */

const { validateConfigUpdate } = require('./config-validation');
const { DEFAULT_AGGRESSIVENESS_PRESETS, PRESET_FIELD_RULES, LEGACY_PRESET_FIELD_RULES } = require('./regime-preset-contract');
const { REGIME_DEFAULTS, BACKUP_INTERVAL_BOUNDS, SENTINEL_POLL_INTERVAL_BOUNDS, SENTINEL_MAX_ALERTS_BOUNDS } = require('./config-utils');

const REGIME_ALLOWED_KEYS = new Set(Object.keys(REGIME_DEFAULTS));

/** Primitive contract for every supported regime setting; preset bounds stay shared. */
const REGIME_FIELD_RULES = {
  enabled: { type: 'boolean' },
  aggressiveness: { type: 'string', enum: ['conservative', 'moderate', 'aggressive', 'maximum'] },
  atrPeriod: { type: 'number' },
  kFactor: { type: 'number' },
  minIntervalMs: { type: 'number' },
  maxIntervalMs: { type: 'number' },
  momentumMult: { type: 'number' },
  volExpansionMult: { type: 'number' },
  volContractionMult: { type: 'number' },
  vwapPeriodHours: { type: 'number' },
  trendConfirmationPeriods: { type: 'number' },
  minOrderSizeUsdc: { type: 'number' },
  baseSizeUsdc: { type: 'number' },
  harvestScale: { type: 'number' },
  cautionScale: { type: 'number' },
  trendScale: { type: 'number' },
  maxCycleBuys: { type: 'number' },
  cycleResetHours: { type: 'number' },
  liquidityFactorCap: { type: 'number' },
  divergenceScalePct: { type: 'number' },
  tpMult: { type: 'number' },
  tpMinPercent: { type: 'number' },
  tpMaxPercent: { type: 'number' },
  tpUpdateThresholdPct: { type: 'number' },
  holdbackRatio: { type: 'number' },
  celestialEnabled: { type: 'boolean' },
  maxCelestialBodies: { type: 'number' },
  mergeProximityScale: { type: 'number' },
  tpAutoManaged: { type: 'boolean' },
  tpEvaluationCycles: { type: 'number' },
  tpEvaluationMaxHours: { type: 'number' },
  tpMinSampleSize: { type: 'number' },
  tpAbsoluteMin: { type: 'number' },
  tpAbsoluteMax: { type: 'number' },
  tpMaxChangePercent: { type: 'number' },
  sizeAutoManaged: { type: 'boolean' },
  sizeEvaluationCycles: { type: 'number' },
  sizeEvaluationMaxHours: { type: 'number' },
  sizeMinSampleSize: { type: 'number' },
  sizeAbsoluteMinBase: { type: 'number' },
  sizeAbsoluteMaxBase: { type: 'number' },
  sizeTargetUtilization: { type: 'number' },
  sizeMaxChangePercent: { type: 'number' },
  sizeAutoCycleBuys: { type: 'boolean' },
  sizeMinCycleBuys: { type: 'number' },
  sizeMaxCycleBuys: { type: 'number' },
  maxAssetExposure: { type: 'number' },
  depositedCapital: { type: 'number' },
  maxUsdcDeployed: { type: 'number' },
  maxDrawdownPercent: { type: 'number' },
  drawdownResetHours: { type: 'number' },
  entryOffsetBps: { type: 'number' },
  entryOffsetUpBps: { type: 'number' },
  entryOffsetDownBps: { type: 'number' },
  entryMaxRetries: { type: 'number' },
  cancelRateLimitMs: { type: 'number' },
  orderStaleMs: { type: 'number' },
  staleDataMs: { type: 'number' },
  staleOrdersMs: { type: 'number' },
  maxRestErrors: { type: 'number' },
  maxRateLimits: { type: 'number' },
  maxLatencyMs: { type: 'number' },
  safeRecoveryMs: { type: 'number' },
  maxOpenOrders: { type: 'number' },
  reconcileIntervalMs: { type: 'number' },
  fillDriftSweepMs: { type: 'number' },
  maxSpreadBps: { type: 'number' },
  spreadPauseMs: { type: 'number' },
  minDepthUsdc: { type: 'number' },
  depthPauseMs: { type: 'number' },
  flashMoveMult: { type: 'number' },
  flashCooldownMs: { type: 'number' },
  cancelEntriesOnFlash: { type: 'boolean' },
  macroEnabled: { type: 'boolean' },
  macroUpdateIntervalMs: { type: 'number' },
  macroHysteresis: { type: 'number' },
  macroAccumulationThreshold: { type: 'number' },
  macroDeclineThreshold: { type: 'number' },
  macroMarkupThreshold: { type: 'number' },
  macroAccumulationSizeMult: { type: 'number' },
  macroAccumulationTpMult: { type: 'number' },
  macroAccumulationOffsetMult: { type: 'number' },
  macroMarkupSizeMult: { type: 'number' },
  macroMarkupTpMult: { type: 'number' },
  macroMarkupOffsetMult: { type: 'number' },
  macroDeclineSizeMult: { type: 'number' },
  macroDeclineTpMult: { type: 'number' },
  macroDeclineOffsetMult: { type: 'number' },
  longTermBiasEnabled: { type: 'boolean' },
  longTermLookbackDays: { type: 'number' },
  longTermUpdateIntervalMs: { type: 'number' },
  autoAggressivenessEnabled: { type: 'boolean' },
  entryMode: { type: 'string', enum: ['reactive', 'ladder'] },
  ladderMaxAthDropPct: { type: 'number' },
  ladderSpacingMode: { type: 'string', enum: ['linear', 'sqrt', 'exponential'] },
  ladderSizeMode: { type: 'string', enum: ['flat', 'linear', 'sqrt', 'fibonacci'] },
  ladderAutoSwitch: { type: 'boolean' },
  ladderAutoSwitchVolMult: { type: 'number' },
  ladderMinSpacingPct: { type: 'number' },
  ...PRESET_FIELD_RULES,
};

/**
 * Prove the primitive and enum contract before any coercive comparisons.
 * @param {unknown} config
 * @returns {config is Partial<RegimeStrategyConfig>}
 */
const hasRegimeFieldTypes = (config) => typeof config === 'object'
  && config !== null && !Array.isArray(config)
  && validateConfigUpdate(REGIME_FIELD_RULES, config).errors.length === 0;

/**
 * Validate regime strategy configuration
 * @param {unknown} config - Untrusted regime config to validate
 * @returns {import('./types').RegimeValidationResult}
 */
const validateRegimeConfig = (config) => {
  if (!hasRegimeFieldTypes(config)) {
    return { valid: false, errors: validateConfigUpdate(REGIME_FIELD_RULES, config).errors };
  }
  const errors = [];

  // Aggressiveness level validation
  if (config.aggressiveness !== undefined) {
    const validLevels = Object.keys(DEFAULT_AGGRESSIVENESS_PRESETS);
    if (!validLevels.includes(config.aggressiveness)) {
      errors.push('aggressiveness must be one of: conservative, moderate, aggressive, maximum');
    }
  }

  // Volatility Clock validation
  if (config.atrPeriod !== undefined && (config.atrPeriod < 5 || config.atrPeriod > 30)) {
    errors.push('atrPeriod must be between 5 and 30');
  }

  // Regime Detection validation
  if (config.momentumMult !== undefined && (config.momentumMult < 1.0 || config.momentumMult > 2.5)) {
    errors.push('momentumMult must be between 1.0 and 2.5');
  }
  if (config.volExpansionMult !== undefined && (config.volExpansionMult < 1.2 || config.volExpansionMult > 2.0)) {
    errors.push('volExpansionMult must be between 1.2 and 2.0');
  }

  // Position Sizing validation
  if (config.minOrderSizeUsdc !== undefined && (config.minOrderSizeUsdc < 1 || config.minOrderSizeUsdc > 100)) {
    errors.push('minOrderSizeUsdc must be between 1 and 100');
  }
  if (config.baseSizeUsdc !== undefined && (config.baseSizeUsdc < 1 || config.baseSizeUsdc > 1000)) {
    errors.push('baseSizeUsdc must be between 1 and 1000');
  }
  if (config.divergenceScalePct !== undefined && (config.divergenceScalePct < 0.5 || config.divergenceScalePct > 20)) {
    errors.push('divergenceScalePct must be between 0.5 and 20');
  }

  // Take-Profit validation
  if (config.tpMinPercent !== undefined && (config.tpMinPercent < 0.01 || config.tpMinPercent > 10.0)) {
    errors.push('tpMinPercent must be between 0.01 and 10.0');
  }
  if (config.tpMaxPercent !== undefined && (config.tpMaxPercent < 0.1 || config.tpMaxPercent > 50.0)) {
    errors.push('tpMaxPercent must be between 0.1 and 50.0');
  }
  if (config.holdbackRatio !== undefined && (config.holdbackRatio < 0.0 || config.holdbackRatio > 1.0)) {
    errors.push('holdbackRatio must be between 0.0 and 1.0');
  }

  // TP Auto-Management validation
  if (config.tpEvaluationCycles !== undefined && (config.tpEvaluationCycles < 1 || config.tpEvaluationCycles > 100)) {
    errors.push('tpEvaluationCycles must be between 1 and 100');
  }
  if (config.tpEvaluationMaxHours !== undefined && (config.tpEvaluationMaxHours < 1 || config.tpEvaluationMaxHours > 168)) {
    errors.push('tpEvaluationMaxHours must be between 1 and 168 (1 week)');
  }
  if (config.tpMinSampleSize !== undefined && (config.tpMinSampleSize < 3 || config.tpMinSampleSize > 100)) {
    errors.push('tpMinSampleSize must be between 3 and 100');
  }
  if (config.tpAbsoluteMin !== undefined && (config.tpAbsoluteMin < 0.01 || config.tpAbsoluteMin > 1.0)) {
    errors.push('tpAbsoluteMin must be between 0.01 and 1.0');
  }
  if (config.tpAbsoluteMax !== undefined && (config.tpAbsoluteMax < 1.0 || config.tpAbsoluteMax > 10.0)) {
    errors.push('tpAbsoluteMax must be between 1.0 and 10.0');
  }
  if (config.tpMaxChangePercent !== undefined && (config.tpMaxChangePercent < 5 || config.tpMaxChangePercent > 50)) {
    errors.push('tpMaxChangePercent must be between 5 and 50');
  }

  // Size Auto-Management validation
  if (config.sizeEvaluationCycles !== undefined && (config.sizeEvaluationCycles < 1 || config.sizeEvaluationCycles > 100)) {
    errors.push('sizeEvaluationCycles must be between 1 and 100');
  }
  if (config.sizeEvaluationMaxHours !== undefined && (config.sizeEvaluationMaxHours < 1 || config.sizeEvaluationMaxHours > 168)) {
    errors.push('sizeEvaluationMaxHours must be between 1 and 168 (1 week)');
  }
  if (config.sizeMinSampleSize !== undefined && (config.sizeMinSampleSize < 1 || config.sizeMinSampleSize > 50)) {
    errors.push('sizeMinSampleSize must be between 1 and 50');
  }
  if (config.sizeAbsoluteMinBase !== undefined && (config.sizeAbsoluteMinBase < 1 || config.sizeAbsoluteMinBase > 100)) {
    errors.push('sizeAbsoluteMinBase must be between 1 and 100');
  }
  if (config.sizeAbsoluteMaxBase !== undefined && (config.sizeAbsoluteMaxBase < 50 || config.sizeAbsoluteMaxBase > 2000)) {
    errors.push('sizeAbsoluteMaxBase must be between 50 and 2000');
  }
  if (config.sizeTargetUtilization !== undefined && (config.sizeTargetUtilization < 0.5 || config.sizeTargetUtilization > 0.99)) {
    errors.push('sizeTargetUtilization must be between 0.5 and 0.99');
  }
  if (config.sizeMaxChangePercent !== undefined && (config.sizeMaxChangePercent < 5 || config.sizeMaxChangePercent > 50)) {
    errors.push('sizeMaxChangePercent must be between 5 and 50');
  }
  if (config.sizeMinCycleBuys !== undefined && (config.sizeMinCycleBuys < 5 || config.sizeMinCycleBuys > 50)) {
    errors.push('sizeMinCycleBuys must be between 5 and 50');
  }
  if (config.sizeMaxCycleBuys !== undefined && (config.sizeMaxCycleBuys < 20 || config.sizeMaxCycleBuys > 200)) {
    errors.push('sizeMaxCycleBuys must be between 20 and 200');
  }

  // Legacy satellite config aliases silently accepted (mapped to celestial equivalents)

  // Celestial Hierarchy validation
  if (config.maxCelestialBodies !== undefined && (!Number.isInteger(config.maxCelestialBodies) || config.maxCelestialBodies < 1 || config.maxCelestialBodies > 15)) {
    errors.push('maxCelestialBodies must be an integer between 1 and 15');
  }

  // Ladder / Entry Mode validation
  if (config.entryMode !== undefined) {
    const allowedEntryModes = ['reactive', 'ladder'];
    if (!allowedEntryModes.includes(config.entryMode)) {
      errors.push(`entryMode must be one of: ${allowedEntryModes.join(', ')}`);
    }
  }
  if (config.ladderMaxAthDropPct !== undefined && (config.ladderMaxAthDropPct < 10 || config.ladderMaxAthDropPct > 95)) {
    errors.push('ladderMaxAthDropPct must be between 10 and 95');
  }
  if (config.ladderSpacingMode !== undefined) {
    const allowedSpacing = ['linear', 'sqrt', 'exponential'];
    if (!allowedSpacing.includes(config.ladderSpacingMode)) {
      errors.push(`ladderSpacingMode must be one of: ${allowedSpacing.join(', ')}`);
    }
  }
  if (config.ladderSizeMode !== undefined) {
    const allowedSizing = ['flat', 'linear', 'sqrt', 'fibonacci'];
    if (!allowedSizing.includes(config.ladderSizeMode)) {
      errors.push(`ladderSizeMode must be one of: ${allowedSizing.join(', ')}`);
    }
  }
  if (config.ladderMinSpacingPct !== undefined && (config.ladderMinSpacingPct < 0.01 || config.ladderMinSpacingPct > 5.0)) {
    errors.push('ladderMinSpacingPct must be between 0.01 and 5.0');
  }

  // Macro Regime validation
  if (config.macroHysteresis !== undefined && (config.macroHysteresis < 1 || config.macroHysteresis > 20)) {
    errors.push('macroHysteresis must be between 1 and 20');
  }
  if (config.macroDeclineThreshold !== undefined && config.macroAccumulationThreshold !== undefined
    && config.macroDeclineThreshold >= config.macroAccumulationThreshold) {
    errors.push('macroDeclineThreshold must be less than macroAccumulationThreshold');
  }
  if (config.macroAccumulationThreshold !== undefined && config.macroMarkupThreshold !== undefined
    && config.macroAccumulationThreshold >= config.macroMarkupThreshold) {
    errors.push('macroAccumulationThreshold must be less than macroMarkupThreshold');
  }
  if (config.macroUpdateIntervalMs !== undefined && (config.macroUpdateIntervalMs < 60000 || config.macroUpdateIntervalMs > 600000)) {
    errors.push('macroUpdateIntervalMs must be between 60000 (1 min) and 600000 (10 min)');
  }
  const macroMultFields = [
    'macroAccumulationSizeMult', 'macroAccumulationTpMult', 'macroAccumulationOffsetMult',
    'macroMarkupSizeMult', 'macroMarkupTpMult', 'macroMarkupOffsetMult',
    'macroDeclineSizeMult', 'macroDeclineTpMult', 'macroDeclineOffsetMult',
  ];
  for (const field of macroMultFields) {
    if (config[field] !== undefined && (config[field] < 0.1 || config[field] > 3.0)) {
      errors.push(`${field} must be between 0.1 and 3.0`);
    }
  }

  // Risk Caps validation
  if (config.maxAssetExposure !== undefined && config.maxAssetExposure !== 0 && (config.maxAssetExposure < 0.01 || config.maxAssetExposure > 10.0)) {
    errors.push('maxAssetExposure must be 0 (uncapped) or between 0.01 and 10.0');
  }
  if (config.depositedCapital !== undefined && config.depositedCapital !== 0 && config.depositedCapital < 100) {
    errors.push('depositedCapital must be 0 (auto-derive) or at least 100');
  }
  if (config.maxUsdcDeployed !== undefined && config.maxUsdcDeployed < 1000) {
    errors.push('maxUsdcDeployed must be at least 1000');
  }
  if (config.maxDrawdownPercent !== undefined && (config.maxDrawdownPercent < 10 || config.maxDrawdownPercent > 30)) {
    errors.push('maxDrawdownPercent must be between 10 and 30');
  }
  if (config.drawdownResetHours !== undefined && (config.drawdownResetHours < 0 || config.drawdownResetHours > 720)) {
    errors.push('drawdownResetHours must be between 0 (disabled) and 720 (30 days)');
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, errors: [], value: config };
};

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
  validateRegimeConfig,
  sanitizeRegimeConfig,
  validateAndSanitizeRegimeConfig,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
  BACKUP_CONFIG_SCHEMA,
  validateNotificationConfigUpdate,
  SENTINEL_CONFIG_SCHEMA,
  validateSentinelConfigUpdate,
};
