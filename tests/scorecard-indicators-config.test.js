// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  INDICATORS,
  INDICATOR_WEIGHTS,
  INDICATOR_LABELS,
} = require('../src/updown/indicator-config');
const { buildScorecardAnalysis } = require('../src/updown/scorecard-analytics');

describe('scorecard indicator configuration', () => {
  it('re-exports the canonical shared catalog without drift', () => {
    const shared = require('../shared/indicator-config');
    assert.equal(INDICATORS, shared.INDICATORS);
    assert.equal(INDICATOR_WEIGHTS, shared.INDICATOR_WEIGHTS);
    assert.equal(INDICATOR_LABELS, shared.INDICATOR_LABELS);
  });

  it('exposes every canonical indicator, label, and base weight through the scorecard API', () => {
    const result = buildScorecardAnalysis([]);

    assert.equal(result.success, true);
    assert.ok(result.catalog, 'catalog should be present');
    assert.deepEqual(
      result.catalog.indicators.map((i) => i.key),
      INDICATORS,
      'catalog indicators should match the canonical catalog'
    );
    assert.deepEqual(
      result.catalog.baseWeights,
      INDICATOR_WEIGHTS,
      'catalog baseWeights should match the canonical weights'
    );

    for (const { key, label } of result.catalog.indicators) {
      assert.equal(label, INDICATOR_LABELS[key], `indicator ${key} label should match the canonical label`);
    }
  });

  it('gives every canonical indicator a label and a base weight', () => {
    for (const key of INDICATORS) {
      assert.ok(INDICATOR_LABELS[key], `indicator ${key} should have a display label`);
      assert.equal(typeof INDICATOR_WEIGHTS[key], 'number', `indicator ${key} should have a numeric base weight`);
    }
  });
});
