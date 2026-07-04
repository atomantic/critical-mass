// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeByHour, buildOutcomeRecord } = require('../src/updown/scorecard');

// issue #212D — byHour must bucket by the hour the PREDICTION was made
// (predictionTs), not the settlement/evaluation hour (ts, up to 1h later).
// Feature 11 in signal-engine.js applies `byHour[predictionHour]` as a
// time-of-day multiplier, so bucketing by settlement time attributes a 1h-window
// outcome to the hour AFTER the prediction was actually made.
describe('computeByHour buckets by prediction hour, not settlement hour (issue #212D)', () => {
  const makeOutcome = ({ predictionTs, ts, correct }) => ({
    compositeCorrect: correct,
    predictionTs,
    ts,
  });

  it('groups a 1h-window outcome under the prediction hour even though ts is an hour later', () => {
    // Prediction made at 13:30 UTC, settled (ts) at 14:30 UTC — the classic 1h-window case.
    const predictionTs = '2026-01-01T13:30:00.000Z';
    const settlementTs = '2026-01-01T14:30:00.000Z';

    const outcomes = [];
    // 5 samples so accuracy computes (min-sample threshold), all correct.
    for (let i = 0; i < 5; i++) {
      outcomes.push(makeOutcome({ predictionTs, ts: settlementTs, correct: true }));
    }

    const byHour = computeByHour(outcomes);
    assert.equal(byHour[13]?.total, 5, 'all 5 outcomes bucket under hour 13 (prediction hour)');
    assert.equal(byHour[14], undefined, 'hour 14 (settlement hour) gets none of them');
  });

  it('falls back to ts for legacy records that predate predictionTs (backward compat)', () => {
    const legacyTs = '2026-01-01T09:15:00.000Z';
    const outcomes = Array.from({ length: 5 }, () => ({ compositeCorrect: true, ts: legacyTs }));
    const byHour = computeByHour(outcomes);
    assert.equal(byHour[9]?.total, 5);
  });

  it('requires at least 5 samples in an hour before reporting an accuracy figure', () => {
    const predictionTs = '2026-01-01T05:00:00.000Z';
    const outcomes = Array.from({ length: 4 }, () => makeOutcome({ predictionTs, ts: predictionTs, correct: true }));
    const byHour = computeByHour(outcomes);
    assert.equal(byHour[5].total, 4);
    assert.equal(byHour[5].accuracy, null, 'below the 5-sample floor, accuracy stays null');
  });
});

// buildOutcomeRecord is the single point where predictionTs is stamped onto an
// outcome from the source prediction — verify it always carries the prediction's ts.
describe('buildOutcomeRecord stamps predictionTs from the source prediction (issue #212D)', () => {
  it('sets predictionTs to prediction.ts regardless of window', () => {
    const prediction = {
      id: 'pred_1',
      ts: '2026-01-01T13:30:00.000Z',
      price: 100,
      compositeScore: 20,
      compositeDirection: 'up',
      timeframes: {},
      contract: null,
    };
    const outcome = buildOutcomeRecord(prediction, 3_600_000, 101);
    assert.equal(outcome.predictionTs, prediction.ts);
  });
});
