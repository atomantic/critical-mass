const { before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { validateRegimeConfig } = require('../src/config-validator')
const { REGIME_DEFAULTS } = require('../src/config-utils')
let CONFIG_FIELD_LABELS, humanizeConfigError, describeConfigSaveError
before(async () => {
  ;({ CONFIG_FIELD_LABELS, humanizeConfigError, describeConfigSaveError } = await import('../admin/src/utils/configSaveError.mjs'))
})

describe('configuration save error copy', () => {
  it('humanizes bare, colon, nested and joined validator messages', () => {
    assert.equal(humanizeConfigError('ladderMaxAthDropPct must be between 10 and 95; regime.minOrderSizeUsdc: expected number, got string; tpAbsoluteMin: must be >= 0.01'),
      'Max ATH Drop % must be between 10 and 95; Min Order Size: expected number, got string; TP Absolute Min %: must be >= 0.01')
    assert.equal(humanizeConfigError('macroDeclineThreshold must be less than macroAccumulationThreshold'), 'Decline Threshold must be less than Accumulation Threshold')
    assert.equal(humanizeConfigError('unknownKey: unexpected value'), 'unknownKey: unexpected value')
    assert.equal(humanizeConfigError('kFactorExtra must be positive'), 'kFactorExtra must be positive')
  })

  it('covers every validator field, including primitive-type failures', () => {
    for (const key of Object.keys(REGIME_DEFAULTS)) {
      const { errors } = validateRegimeConfig({ [key]: null })
      for (const error of errors) {
        assert.ok(CONFIG_FIELD_LABELS[key], `missing UI label for ${key}`)
        assert.ok(!humanizeConfigError(error).startsWith(key), error)
      }
    }
  })

  it('prioritizes persisted state, preserves every rejection reason and handles absent bodies', () => {
    assert.deepEqual(describeConfigSaveError(503, { persisted: true, applied: false, error: 'engine unavailable' }), { kind: 'notApplied', message: 'engine unavailable' })
    assert.deepEqual(describeConfigSaveError(400, { errors: ['kFactor: must be >= 0.2', 'minIntervalMs: must be >= 30000'] }), {
      kind: 'rejected', message: 'k Factor: must be >= 0.2; Min Interval: must be >= 30000',
    })
    assert.equal(describeConfigSaveError(503, { persisted: true, errors: ['enabled: expected boolean'] }).kind, 'notApplied')
    for (const body of [undefined, null, {}, { errors: [] }]) {
      assert.deepEqual(describeConfigSaveError(502, body), { kind: 'failed', message: 'Could not save settings (HTTP 502)' })
    }
    assert.equal(describeConfigSaveError(null, new Error('Network offline')).message, 'Network offline')
    assert.equal(describeConfigSaveError(null, {}).kind, 'failed')
  })
})
