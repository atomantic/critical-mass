// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tallyHistory } = require('../src/updown/scorecard');

// ============================================================================
// tallyHistory — reload counting must mirror the live recordPrediction path:
// neutral predictions are *skips*, not predictions (issue #158). Counting every
// prediction record (neutrals included) double-categorizes neutrals.
// ============================================================================
describe('tallyHistory', () => {
  it('excludes neutral predictions from totalPredictions', () => {
    const records = [
      { type: 'prediction', compositeDirection: 'up' },
      { type: 'prediction', compositeDirection: 'down' },
      { type: 'prediction', compositeDirection: 'neutral' },
      { type: 'prediction', compositeDirection: 'neutral' },
      { type: 'prediction', compositeDirection: 'up' },
    ];

    const { predCount, skipCount, totalPredictions } = tallyHistory(records);

    assert.equal(predCount, 5, 'predCount counts every prediction record');
    assert.equal(skipCount, 2, 'skipCount counts only neutral predictions');
    // The bug set totalPredictions = predCount (5); correct value excludes neutrals.
    assert.equal(totalPredictions, 3, 'totalPredictions = predCount - skipCount');
  });

  it('keeps totalPredictions === predCount when there are no neutrals', () => {
    const records = [
      { type: 'prediction', compositeDirection: 'up' },
      { type: 'prediction', compositeDirection: 'down' },
    ];

    const { predCount, skipCount, totalPredictions } = tallyHistory(records);

    assert.equal(skipCount, 0);
    assert.equal(predCount, 2);
    assert.equal(totalPredictions, 2);
  });

  it('collects only outcomes that have a resolved compositeCorrect', () => {
    const resolved = { type: 'outcome', compositeCorrect: true };
    const records = [
      resolved,
      { type: 'outcome', compositeCorrect: false },
      { type: 'outcome', compositeCorrect: null }, // unresolved — excluded
      { type: 'prediction', compositeDirection: 'up' },
    ];

    const { outcomes, predCount } = tallyHistory(records);

    assert.equal(outcomes.length, 2, 'only outcomes with compositeCorrect != null');
    assert.equal(outcomes[0], resolved);
    assert.equal(predCount, 1);
  });

  it('ignores null/malformed and unrelated records', () => {
    const records = [
      null,
      { type: 'weights', weights: {} },
      { type: 'prediction', compositeDirection: 'up' },
    ];

    const { outcomes, predCount, skipCount, totalPredictions } = tallyHistory(records);

    assert.equal(outcomes.length, 0);
    assert.equal(predCount, 1);
    assert.equal(skipCount, 0);
    assert.equal(totalPredictions, 1);
  });

  it('returns zeroed counts for an empty record set', () => {
    const result = tallyHistory([]);
    assert.deepEqual(result, { outcomes: [], predCount: 0, skipCount: 0, totalPredictions: 0 });
  });
});
