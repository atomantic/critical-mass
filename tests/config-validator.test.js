// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateConfigUpdate,
  sanitizeRegimeConfig,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
} = require('../src/config-validator');

const { DEFAULT_AGGRESSIVENESS_PRESETS, PRESET_KEYS, PRESET_FIELD_RULES, LEGACY_PRESET_FIELD_RULES } = require('../src/regime-preset-contract');

describe('validateConfigUpdate', () => {
  it('returns empty value and error for non-object input', () => {
    for (const bad of [null, undefined, 'str', 42, true, [1, 2]]) {
      const { value, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, bad);
      assert.deepStrictEqual(value, {});
      assert.equal(errors.length, 1);
      assert.match(errors[0], /must be an object/);
    }
  });

  it('passes through allowed fields with correct types', () => {
    const { value, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, {
      enabled: true,
      dryRun: false,
      productId: 'BTC-USD',
      amount: 50,
    });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(value, {
      enabled: true,
      dryRun: false,
      productId: 'BTC-USD',
      amount: 50,
    });
  });

  it('silently drops unknown fields', () => {
    const { value, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, {
      enabled: true,
      __proto__injected: true,
      hackField: 'evil',
    });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(value, { enabled: true });
  });

  it('rejects wrong types with error messages', () => {
    const { value, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, {
      enabled: 'yes',
      amount: 'fifty',
    });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /enabled.*expected boolean/);
    assert.match(errors[1], /amount.*expected number/);
    assert.deepStrictEqual(value, {});
  });

  it('enforces numeric min/max bounds', () => {
    const { errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, {
      intervalsToSpread: 0,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /intervalsToSpread.*>= 1/);
  });

  it('rejects non-finite numbers', () => {
    const { errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, {
      amount: Infinity,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /amount.*finite/);
  });

  it('enforces enum constraints', () => {
    const { errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, {
      dcaStrategy: 'invalid',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /dcaStrategy.*one of/);
  });

  it('dcaStrategy enum matches engine-honored values (fixed, fibonacci)', () => {
    // The engine branches on dcaStrategy === 'fibonacci' (dca-engine.js,
    // state-tracker.js, backtest-engine.js); 'regime' is not read anywhere.
    for (const strategy of ['fixed', 'fibonacci']) {
      const { value, errors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, { dcaStrategy: strategy });
      assert.deepStrictEqual(errors, [], `expected ${strategy} to be accepted`);
      assert.deepStrictEqual(value, { dcaStrategy: strategy });
    }
    // 'regime' is inert in the engine and must be rejected.
    const { errors: regimeErrors } = validateConfigUpdate(EXCHANGE_CONFIG_SCHEMA, { dcaStrategy: 'regime' });
    assert.equal(regimeErrors.length, 1);
    assert.match(regimeErrors[0], /dcaStrategy.*one of/);
  });

  it('EXCHANGE_CONFIG_SCHEMA includes all DEFAULTS fields', () => {
    const expected = [
      'enabled', 'dryRun', 'productId', 'dcaStrategy', 'intervalType',
      'amount', 'totalAllocation', 'intervalsToSpread',
      'sellMarkupPercent', 'holdbackPercent', 'minOrderSize', 'maxBuyPrice', 'fibBaseAmount',
    ];
    for (const field of expected) {
      assert.ok(EXCHANGE_CONFIG_SCHEMA[field], `missing field: ${field}`);
    }
  });

  it('covers exactly the declared preset keys and preserves every complete preset', () => {
    const declaredKeys = [...new Set(Object.values(DEFAULT_AGGRESSIVENESS_PRESETS).flatMap(Object.keys))].sort();
    assert.deepStrictEqual([...PRESET_KEYS].sort(), declaredKeys);
    assert.deepStrictEqual(Object.keys(PRESET_FIELD_RULES).sort(), declaredKeys);
    for (const [level, preset] of Object.entries(DEFAULT_AGGRESSIVENESS_PRESETS)) {
      const { value, errors } = validateConfigUpdate(AGGRESSIVENESS_SCHEMA, preset);
      assert.deepStrictEqual(errors, [], level);
      assert.deepStrictEqual(value, preset, level);
    }
  });

  it('accepts shared boundaries and rejects invalid values for every canonical field', () => {
    for (const key of PRESET_KEYS) {
      const { min, max } = PRESET_FIELD_RULES[key];
      for (const boundary of [min, max]) {
        const result = validateConfigUpdate(AGGRESSIVENESS_SCHEMA, { [key]: boundary });
        assert.deepStrictEqual(result.errors, [], key);
        assert.deepStrictEqual(result.value, { [key]: boundary });
      }
      for (const invalid of [min - 1, max + 1, NaN, Infinity, -Infinity, null, '2', true]) {
        const result = validateConfigUpdate(AGGRESSIVENESS_SCHEMA, { [key]: invalid });
        assert.equal(result.errors.length, 1, key);
        assert.deepStrictEqual(result.value, {});
      }
    }
  });

  it('rejects the four values formerly accepted at save but rejected at application', () => {
    for (const update of [{ kFactor: 0.9 }, { minIntervalMs: 1000 }, { maxIntervalMs: 86400000 }, { maxCycleBuys: 1 }]) {
      assert.equal(validateConfigUpdate(AGGRESSIVENESS_SCHEMA, update).errors.length, 1);
    }
  });

  it('keeps legacy schema-only keys separate and preserves unknown-key behavior', () => {
    const legacy = { targetMarkup: 0.1, minMarkup: 0.01, maxMarkup: 1, sizeMultiplier: 2 };
    assert.deepStrictEqual(Object.keys(LEGACY_PRESET_FIELD_RULES).sort(), Object.keys(legacy).sort());
    assert.ok(Object.keys(legacy).every(key => !PRESET_KEYS.includes(key)));
    assert.deepStrictEqual(validateConfigUpdate(AGGRESSIVENESS_SCHEMA, { ...legacy, obsolete: 42 }),
      { value: legacy, errors: [] });
    for (const key of Object.keys(legacy)) {
      assert.equal(validateConfigUpdate(AGGRESSIVENESS_SCHEMA, { [key]: -1 }).errors.length, 1);
      assert.equal(validateConfigUpdate(AGGRESSIVENESS_SCHEMA, { [key]: 'bad' }).errors.length, 1);
    }
  });

  it('validates aggressiveness fields correctly', () => {
    const { value, errors } = validateConfigUpdate(AGGRESSIVENESS_SCHEMA, {
      kFactor: 0.5,
      entryOffsetBps: 50,
      cautionScale: 2,
      trendScale: 1.5,
      maxCycleBuys: 10,
    });
    assert.deepStrictEqual(errors, []);
    assert.equal(value.kFactor, 0.5);
    assert.equal(value.entryOffsetBps, 50);
    assert.equal(value.maxCycleBuys, 10);
  });
});

describe('sanitizeRegimeConfig', () => {
  it('keeps canonical regime fields and reports stale keys', () => {
    const result = sanitizeRegimeConfig({ enabled: true, baseSizeUsdc: 25, obsoleteField: 1 });
    assert.deepStrictEqual(result.value, { enabled: true, baseSizeUsdc: 25 });
    assert.deepStrictEqual(result.droppedKeys, ['obsoleteField']);
  });

  it('returns an empty sanitized object for non-object input', () => {
    assert.deepStrictEqual(sanitizeRegimeConfig(null), { value: {}, droppedKeys: [] });
    assert.deepStrictEqual(sanitizeRegimeConfig([]), { value: {}, droppedKeys: [] });
  });
});
