// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { INDICATORS: serverIndicators, INDICATOR_WEIGHTS: serverWeights, INDICATOR_LABELS: serverLabels } = require('../src/updown/indicator-config');

describe('scorecard indicator configuration', () => {
  it('scorecard API exposes matching indicators and base weights', async () => {
    // Dynamically import the ES6 shared config used by admin client
    const sharedConfig = await import('../shared/indicator-config.mjs');
    const sharedIndicators = sharedConfig.INDICATORS;
    const sharedWeights = sharedConfig.INDICATOR_WEIGHTS;
    const sharedLabels = sharedConfig.INDICATOR_LABELS;

    // Verify server config matches shared config
    assert.deepEqual(serverIndicators, sharedIndicators, 'server INDICATORS should match shared config');
    assert.deepEqual(serverWeights, sharedWeights, 'server INDICATOR_WEIGHTS should match shared config');
    assert.deepEqual(serverLabels, sharedLabels, 'server INDICATOR_LABELS should match shared config');

    const { buildScorecardAnalysis } = require('../src/updown/scorecard-analytics');

    // Mock journal records with no actual data
    const result = buildScorecardAnalysis([]);

    assert.equal(result.success, true, 'API should return success');
    assert.ok(result.catalog, 'API should expose catalog');
    assert.ok(result.catalog.indicators, 'catalog should have indicators');
    assert.ok(result.catalog.baseWeights, 'catalog should have baseWeights');

    // Verify indicators in catalog match source
    const catalogKeys = result.catalog.indicators.map(i => i.key);
    assert.deepEqual(catalogKeys, sharedIndicators, 'catalog indicators should match shared config');

    // Verify base weights in catalog match source
    assert.deepEqual(result.catalog.baseWeights, sharedWeights, 'catalog baseWeights should match shared config');

    // Verify all indicators have labels
    for (const { key, label } of result.catalog.indicators) {
      assert.ok(label, `indicator ${key} should have a label in catalog`);
      assert.equal(label, sharedLabels[key], `indicator ${key} label should match shared config`);
    }
  });
});
