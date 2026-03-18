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

module.exports = {
  validateConfigUpdate,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
};
