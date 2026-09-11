// @ts-check

/**
 * Pick only allowed keys from an update object, with optional type/range checks.
 * @param {Object} schema - Map of allowed field names to validation rules
 * @param {unknown} update - The incoming update (e.g. req.body)
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

module.exports = { validateConfigUpdate };
