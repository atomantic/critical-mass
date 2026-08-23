// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createScorecard } = require('../src/updown/scorecard');

describe('scorecard journal health', () => {
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
});
