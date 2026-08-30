// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createScorecard } = require('../src/updown/scorecard');

describe('scorecard journal health', () => {
  it('keeps getMetrics as a pure read with no journal writes', async () => {
    const writes = [];
    const scorecard = createScorecard({
      io: { to: () => ({ emit: () => {} }) },
      lastPriceFn: () => 100,
      journalWriter: record => { writes.push(record); },
    });

    const first = scorecard.getMetrics();
    const second = scorecard.getMetrics();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(first.adaptiveWeights, second.adaptiveWeights);
    assert.equal(writes.length, 0, 'reading metrics must not train or persist weights');
    scorecard.stop();
  });

  it('makes a journal write failure observable in metrics', async () => {
    const scorecard = createScorecard({
      io: { to: () => ({ emit: () => {} }) },
      lastPriceFn: () => 100,
      journalWriter: () => Promise.reject(new Error('disk full')),
    });

    scorecard.recordPrediction({ score: 20, type: 'BUY', confidence: 0.8, timeframes: {} }, 'signal_change');
    await new Promise(resolve => setImmediate(resolve));

    const metrics = scorecard.getMetrics();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(metrics.journal.healthy, false);
    assert.equal(metrics.journal.lastError, 'disk full');
    assert.ok(metrics.journal.lastErrorAt);
    scorecard.stop();
  });

  it('recovers journal health after a later successful write', async () => {
    let attempts = 0;
    const scorecard = createScorecard({
      io: { to: () => ({ emit: () => {} }) },
      lastPriceFn: () => 100,
      journalWriter: () => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error('temporary outage'));
        return Promise.resolve();
      },
    });

    scorecard.recordPrediction({ score: 20, type: 'BUY', confidence: 0.8, timeframes: {} }, 'signal_change');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scorecard.getMetrics().journal.healthy, false);

    scorecard.recordPrediction({ score: 0, type: 'NEUTRAL', confidence: 0, timeframes: {} }, 'interval');
    await new Promise(resolve => setImmediate(resolve));
    const health = scorecard.getMetrics().journal;
    assert.equal(health.healthy, true);
    assert.equal(health.lastError, null);
    assert.ok(health.lastSuccessAt);
    scorecard.stop();
  });
});
