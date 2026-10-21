// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findUnsettledPredictions, findUnsettledContractPredictions } = require('../src/updown/scorecard');

// Restart recovery must honor the same MAX_EVAL_LAG_MS (60s) live evaluation uses:
// a window whose first later price arrives hours late is expired, never settled.
describe('recovery lag limit', () => {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const pred = (id, ms, extra = {}) => ({
    type: 'prediction', id, ts: iso(ms), price: 100, compositeDirection: 'up', timeframes: {}, contract: null, ...extra,
  });
  const lateSample = (ms) => ({ type: 'prediction', id: `s${ms}`, ts: iso(ms), price: 110, compositeDirection: 'neutral' });

  it('does not settle a window against a price more than 60s past target, and expires it', () => {
    const records = [pred('p1', t0), lateSample(t0 + 60_000 + 3 * 3_600_000)];
    const { elapsed } = findUnsettledPredictions(records, t0 + 4 * 3_600_000);
    const oneMin = elapsed.find(e => e.windowMs === 60_000);
    assert.equal(oneMin.exitPrice, null);
    assert.equal(oneMin.expired, true);
  });

  it('still settles within the lag limit', () => {
    const records = [pred('p1', t0), lateSample(t0 + 60_000 + 30_000)];
    const { elapsed } = findUnsettledPredictions(records, t0 + 120_000);
    const oneMin = elapsed.find(e => e.windowMs === 60_000);
    assert.equal(oneMin.exitPrice, 110);
    assert.equal(oneMin.expired, false);
  });

  it('does not expire a window still inside the lag allowance', () => {
    const { elapsed } = findUnsettledPredictions([pred('p1', t0)], t0 + 60_000 + 10_000);
    const oneMin = elapsed.find(e => e.windowMs === 60_000);
    assert.equal(oneMin.exitPrice, null);
    assert.equal(oneMin.expired, false);
  });

  it('treats an expired marker as settled so a later restart records no outcome', () => {
    const records = [
      pred('p1', t0),
      { type: 'expired', predictionId: 'p1', window: '1m', ts: iso(t0 + 200_000) },
      lateSample(t0 + 3_600_000),
    ];
    const { elapsed } = findUnsettledPredictions(records, t0 + 4 * 3_600_000);
    assert.equal(elapsed.find(e => e.windowMs === 60_000), undefined);
  });

  it('applies the same rule to contract recovery', () => {
    const expiry = t0 + 300_000;
    const p = pred('c1', t0, { contract: { expiry } });
    const late = lateSample(expiry + 3_600_000);
    const now = expiry + 4 * 3_600_000;
    const first = findUnsettledContractPredictions([p, late], now);
    assert.equal(first.elapsed[0].exitPrice, null);
    assert.equal(first.elapsed[0].expired, true);
    const marker = { type: 'expired', predictionId: 'c1', window: 'contract', ts: iso(now) };
    assert.deepEqual(findUnsettledContractPredictions([p, late, marker], now + 1000).elapsed, []);
  });
});
