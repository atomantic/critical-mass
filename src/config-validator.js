// @ts-check
/**
 * Configuration update validation with schema-based whitelisting.
 * Prevents arbitrary field injection from `{ ...config, ...req.body }`.
 */

/**
 * Pick only allowed keys from an update object, with optional type/range checks.
 * @param {Object} schema - Map of allowed field names to validation rules
 * @param {Object} update - The incoming update (e.g. req.body)
 * @returns {{ value: Object, errors: string[] }}
 */
const validateConfigUpdate = (schema, update) => {
  const result = {};
  const errors = [];

  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return { value: result, errors: ['update must be an object'] };
  }

  for (const [key, value] of Object.entries(update)) {
    const rule = schema[key];
    if (!rule) continue; // silently drop unknown fields

    if (rule.type && typeof value !== rule.type) {
      errors.push(`${key}: expected ${rule.type}, got ${typeof value}`);
      continue;
    }

    if (rule.type === 'number') {
      if (!Number.isFinite(value)) {
        errors.push(`${key}: must be a finite number`);
        continue;
      }
      if (rule.min !== undefined && value < rule.min) {
        errors.push(`${key}: must be >= ${rule.min}`);
        continue;
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(`${key}: must be <= ${rule.max}`);
        continue;
      }
    }

    if (rule.enum && !rule.enum.includes(value)) {
      errors.push(`${key}: must be one of [${rule.enum.join(', ')}]`);
      continue;
    }

    result[key] = value;
  }

  return { value: result, errors };
};

// ── Kalshi config schema ─────────────────────────────────────────
const KALSHI_CONFIG_SCHEMA = {
  enabled: { type: 'boolean' },
  dryRun: { type: 'boolean' },
  apiEnvironment: { type: 'string', enum: ['demo', 'prod'] },
  tradeSizeDollars: { type: 'number', min: 1, max: 25000 },
  maxActiveTrades: { type: 'number', min: 1, max: 100 },
  maxDailyLoss: { type: 'number', min: 0, max: 100000 },
  maxDailyTrades: { type: 'number', min: 1, max: 1000 },
  evaluationIntervalMs: { type: 'number', min: 1000, max: 600000 },
  marketRefreshIntervalMs: { type: 'number', min: 5000, max: 3600000 },
  enablePreSettlementExit: { type: 'boolean' },
  preSettlementExitMs: { type: 'number', min: 0, max: 900000 },
  minProfitCents: { type: 'number', min: 0, max: 100 },
  maxLossCents: { type: 'number', min: 0, max: 100 },
  enableAutoTuner: { type: 'boolean' },
  // strategies and markets are nested objects — validated via pass-through in route handler
};

// ── Strategy config schema (common fields across all strategies) ─
const STRATEGY_CONFIG_SCHEMA = {
  enabled: { type: 'boolean' },
  mode: { type: 'string', enum: ['shadow', 'live'] },
  sizing: { type: 'number', min: 1, max: 25000 },
  minEdge: { type: 'number', min: 0, max: 1 },
  maxExposure: { type: 'number', min: 0, max: 100000 },
  maxActiveTrades: { type: 'number', min: 0, max: 100 },
  minProbability: { type: 'number', min: 0, max: 1 },
  maxProbability: { type: 'number', min: 0, max: 1 },
  minTTL: { type: 'number', min: 0, max: 86400000 },
  maxTTL: { type: 'number', min: 0, max: 86400000 },
  takeProfitCents: { type: 'number', min: 0, max: 100 },
  stopLossCents: { type: 'number', min: 0, max: 100 },
  cooldownMs: { type: 'number', min: 0, max: 3600000 },
};

// ── Exchange config schema ───────────────────────────────────────
const EXCHANGE_CONFIG_SCHEMA = {
  enabled: { type: 'boolean' },
  dryRun: { type: 'boolean' },
  productId: { type: 'string' },
  dcaStrategy: { type: 'string', enum: ['fixed', 'regime'] },
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
const AGGRESSIVENESS_SCHEMA = {
  kFactor: { type: 'number', min: 0.01, max: 1 },
  minIntervalMs: { type: 'number', min: 1000, max: 3600000 },
  maxIntervalMs: { type: 'number', min: 1000, max: 86400000 },
  targetMarkup: { type: 'number', min: 0, max: 1 },
  minMarkup: { type: 'number', min: 0, max: 1 },
  maxMarkup: { type: 'number', min: 0, max: 1 },
  sizeMultiplier: { type: 'number', min: 0.1, max: 10 },
  entryOffsetBps: { type: 'number', min: 0, max: 1000 },
  cautionScale: { type: 'number', min: 0, max: 10 },
  trendScale: { type: 'number', min: 0, max: 10 },
  maxCycleBuys: { type: 'number', min: 1, max: 100 },
};

/**
 * Validate a nested strategies object — each key maps to a strategy config.
 * Returns sanitized strategies with only allowed fields per entry.
 * @param {Object} strategies - e.g. { momentum: { enabled: true, sizing: 100 }, ... }
 * @returns {{ value: Object, errors: string[] }}
 */
const validateStrategies = (strategies) => {
  if (typeof strategies !== 'object' || strategies === null || Array.isArray(strategies)) {
    return { value: {}, errors: ['strategies must be an object'] };
  }
  const result = {};
  const errors = [];
  for (const [name, config] of Object.entries(strategies)) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      errors.push(`strategies.${name}: must be an object`);
      continue;
    }
    const { value, errors: fieldErrors } = validateConfigUpdate(STRATEGY_CONFIG_SCHEMA, config);
    fieldErrors.forEach(e => errors.push(`strategies.${name}.${e}`));
    result[name] = value;
  }
  return { value: result, errors };
};

/**
 * Validate a nested markets object — each key maps to a market config.
 * Only allows plain objects as values (no arrays, no primitives).
 * @param {Object} markets
 * @returns {{ value: Object, errors: string[] }}
 */
const validateMarkets = (markets) => {
  if (typeof markets !== 'object' || markets === null || Array.isArray(markets)) {
    return { value: {}, errors: ['markets must be an object'] };
  }
  const result = {};
  const errors = [];
  for (const [key, value] of Object.entries(markets)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`markets.${key}: must be an object`);
      continue;
    }
    result[key] = value;
  }
  return { value: result, errors };
};

module.exports = {
  validateConfigUpdate,
  validateStrategies,
  validateMarkets,
  KALSHI_CONFIG_SCHEMA,
  STRATEGY_CONFIG_SCHEMA,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
};
