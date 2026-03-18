// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateConfigUpdate,
  EXCHANGE_CONFIG_SCHEMA,
  AGGRESSIVENESS_SCHEMA,
} = require('../src/config-validator');

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

  it('AGGRESSIVENESS_SCHEMA includes all preset fields', () => {
    const expected = [
      'kFactor', 'minIntervalMs', 'maxIntervalMs',
      'entryOffsetBps', 'cautionScale', 'trendScale', 'maxCycleBuys',
    ];
    for (const field of expected) {
      assert.ok(AGGRESSIVENESS_SCHEMA[field], `missing field: ${field}`);
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
