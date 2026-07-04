// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { scoreRSI, scoreBollinger, scoreMomentumAcceleration } = require('../src/updown/signal-engine');

// issue #212B — once calculateRSI/calculateBollingerBands return null for insufficient
// data (instead of a bare 0), every scorer that consumes them must treat null as
// neutral (0), not as an extreme reading.
describe('scoreRSI / scoreBollinger treat null (insufficient data) as neutral (issue #212B)', () => {
  it('scoreRSI returns 0 for null across all trend biases', () => {
    assert.equal(scoreRSI(null, 'neutral'), 0);
    assert.equal(scoreRSI(null, 'bullish'), 0);
    assert.equal(scoreRSI(null, 'bearish'), 0);
  });

  it('scoreRSI still returns the extreme-oversold score for a real RSI=0 reading', () => {
    // A real RSI=0 (not null) is a legitimate deep-oversold reading and should still score +80.
    assert.equal(scoreRSI(0, 'neutral'), 80);
  });

  it('scoreBollinger returns 0 for null across all trend biases', () => {
    assert.equal(scoreBollinger(null, 'neutral'), 0);
    assert.equal(scoreBollinger(null, 'bullish'), 0);
    assert.equal(scoreBollinger(null, 'bearish'), 0);
  });

  it('scoreBollinger still returns the mean-reversion oversold score for a real percentB=0 reading', () => {
    // percentB===0 sits exactly on the lower band (< 0.2, not < 0) — scoreBollinger's
    // own threshold, not related to the null-sentinel guard under test here.
    assert.equal(scoreBollinger(0, 'neutral'), 50);
    // A real below-band reading (percentB < 0) is the true "extreme" case.
    assert.equal(scoreBollinger(-0.1, 'neutral'), 80);
  });
});

// issue #212B — scoreMomentumAcceleration's contrarian RSI-context bonus does its own
// `rsi < 35` / `rsi > 65` comparisons independent of scoreRSI. A null rsi coerces to 0
// in a relational comparison (`null < 35` === true), so without an explicit null guard
// this would ALSO read "insufficient data" as oversold and grant the 1.5x momentum bonus.
describe('scoreMomentumAcceleration ignores the RSI-context bonus when rsi is null (issue #212B)', () => {
  it('does not apply the oversold+up bonus when rsi is null', () => {
    const momentum = { direction: 'up', acceleration: 'steady', magnitude: 1 };
    const withNullRsi = scoreMomentumAcceleration(momentum, null, 'neutral');
    const withRealMidRsi = scoreMomentumAcceleration(momentum, 50, 'neutral'); // same non-bonus case
    assert.equal(withNullRsi, withRealMidRsi, 'null rsi should score identically to a neutral (non-oversold) real rsi');
    assert.equal(withNullRsi, 30, 'base "up" score with no acceleration/bonus multiplier');
  });

  it('does not apply the overbought+down bonus when rsi is null', () => {
    const momentum = { direction: 'down', acceleration: 'steady', magnitude: 1 };
    const withNullRsi = scoreMomentumAcceleration(momentum, null, 'neutral');
    assert.equal(withNullRsi, -30, 'base "down" score with no bonus multiplier');
  });

  it('still applies the bonus for a real oversold rsi (sanity check the guard did not disable the feature)', () => {
    const momentum = { direction: 'up', acceleration: 'steady', magnitude: 1 };
    const withOversoldRsi = scoreMomentumAcceleration(momentum, 25, 'neutral');
    assert.equal(withOversoldRsi, 45, 'oversold+up applies the 1.5x contrarian bonus (30 * 1.5)');
  });
});
