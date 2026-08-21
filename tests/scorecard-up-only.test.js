// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDirection, buildOutcomeRecord, tallyHistory, findUnsettledPredictions, scorecardDirection } = require('../src/updown/scorecard');

describe('scorecardDirection treats a gated long as a skip, not an UP call', () => {
  it('maps score=+25 with a closed trend gate to neutral', () => {
    assert.equal(scorecardDirection({ score: 25, trendGate: { open: false } }), 'neutral')
  })
  it('keeps score=+25 as up when the gate is open', () => {
    assert.equal(scorecardDirection({ score: 25, trendGate: { open: true } }), 'up')
  })
  it('does not rewrite a DOWN score', () => {
    assert.equal(scorecardDirection({ score: -25, trendGate: { open: false } }), 'down')
  })
  it('maps a published NEUTRAL / NO_TRADE_ZONE +score to a skip', () => {
    assert.equal(scorecardDirection({ score: 40, type: 'NO_TRADE_ZONE' }), 'neutral')
    assert.equal(scorecardDirection({ score: 18, type: 'NEUTRAL', trendGate: { open: true } }), 'neutral')
  })
  it('journals a vol-lowered BUY (score 12–15) as UP — published type wins over getDirection 15', () => {
    assert.equal(scorecardDirection({ score: 13, type: 'BUY', trendGate: { open: true } }), 'up')
    assert.equal(scorecardDirection({ score: 13, type: 'STRONG_BUY', trendGate: { open: true } }), 'up')
  })
  it('does not journal a +score SELL as an UP call', () => {
    assert.equal(scorecardDirection({ score: 20, type: 'SELL', trendGate: { open: true } }), 'neutral')
  })
})

describe('evaluateDirection options vs perp (UP-only products)', () => {
  it('options mode: a no-move is a miss (Crypto.com Up option expires OTM on a tie)', () => {
    assert.equal(evaluateDirection('up', 0, 60_000, 'options'), false);
    assert.equal(evaluateDirection('up', 3, 60_000, 'options'), false); // 3 bps < 5 bps 1m floor
  });

  it('options mode: a real up-move is a hit', () => {
    assert.equal(evaluateDirection('up', 12, 60_000, 'options'), true);
    assert.equal(evaluateDirection('up', 25, 300_000, 'options'), true);
  });

  it('perp mode: a no-move is a scratch (null), not a loss', () => {
    assert.equal(evaluateDirection('up', 0, 60_000, 'perp'), null);
    assert.equal(evaluateDirection('up', 3, 60_000, 'perp'), null);
  });

  it('perp mode: a real up-move is still a hit, a real down-move is a miss', () => {
    assert.equal(evaluateDirection('up', 12, 60_000, 'perp'), true);
    assert.equal(evaluateDirection('up', -20, 60_000, 'perp'), false);
  });

  it('defaults to options mode so existing callers keep treating no-move as wrong', () => {
    assert.equal(evaluateDirection('up', 0, 60_000), false);
  });

  it('still skips neutrals in both modes', () => {
    assert.equal(evaluateDirection('neutral', 50, 60_000, 'options'), null);
    assert.equal(evaluateDirection('neutral', 50, 60_000, 'perp'), null);
  });
});

describe('buildOutcomeRecord records both options and perp correctness', () => {
  const upPred = {
    id: 'p1',
    ts: '2026-01-01T00:00:00.000Z',
    price: 100,
    compositeScore: 20,
    compositeDirection: 'up',
    timeframes: {},
    contract: null,
  };

  it('a 1m no-move UP is options-wrong and perp-scratch', () => {
    // +2 bps on 1m (floor 5)
    const outcome = buildOutcomeRecord(upPred, 60_000, 100.02);
    assert.equal(outcome.compositeCorrect, false, 'options: flat/chop is a miss');
    assert.equal(outcome.perpCorrect, null, 'perp: flat is a scratch');
  });

  it('a 1m up-move UP is a hit on both', () => {
    const outcome = buildOutcomeRecord(upPred, 60_000, 100.20); // +20 bps
    assert.equal(outcome.compositeCorrect, true);
    assert.equal(outcome.perpCorrect, true);
  });

  it('accepts an explicit settlement timestamp so historical backfill does not stamp wall-clock now', () => {
    const settled = '2026-01-01T00:05:00.000Z';
    const outcome = buildOutcomeRecord(upPred, 300_000, 101, { ts: settled });
    assert.equal(outcome.ts, settled);
    assert.equal(outcome.predictionTs, upPred.ts);
  });
});

describe('tallyHistory counts only UP predictions as trades', () => {
  it('treats DOWN the same as NEUTRAL — a skip, not a scored long', () => {
    const records = [
      { type: 'prediction', compositeDirection: 'up' },
      { type: 'prediction', compositeDirection: 'down' },
      { type: 'prediction', compositeDirection: 'neutral' },
      { type: 'prediction', compositeDirection: 'up' },
    ];
    const { predCount, skipCount, totalPredictions } = tallyHistory(records);
    assert.equal(predCount, 4);
    assert.equal(skipCount, 2, 'down + neutral');
    assert.equal(totalPredictions, 2, 'only UP calls are longs we score');
  });
});

describe('findUnsettledPredictions ignores DOWN the way it ignores NEUTRAL', () => {
  it('still uses a later DOWN sample as a price point for UP backfill', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const later = '2026-01-01T00:01:05.000Z';
    const records = [
      {
        type: 'prediction', id: 'p-up', ts: t0, price: 100, compositeDirection: 'up',
      },
      {
        type: 'prediction', id: 'p-down', ts: later, price: 101.5, compositeDirection: 'down',
      },
    ];
    const now = Date.parse(t0) + 10 * 60_000;
    const { elapsed } = findUnsettledPredictions(records, now);
    const oneMin = elapsed.find(e => e.prediction.id === 'p-up' && e.windowMs === 60_000);
    assert.equal(oneMin?.exitPrice, 101.5, 'DOWN samples still feed the price timeline');
  });

  it('does not schedule evaluation for a DOWN prediction', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const records = [{
      type: 'prediction',
      id: 'p-down',
      ts: t0,
      price: 100,
      compositeDirection: 'down',
    }];
    const now = Date.parse(t0) + 10 * 60_000;
    const { pending, elapsed } = findUnsettledPredictions(records, now);
    assert.equal(pending.length, 0);
    assert.equal(elapsed.length, 0);
  });
});
