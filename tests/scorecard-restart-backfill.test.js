// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findUnsettledPredictions, buildOutcomeRecord } = require('../src/updown/scorecard');

// issue #212E — predictions in flight at shutdown were never settled: their outcome
// evaluation lived only in a setTimeout that stop() clears, so a restart permanently
// stranded up to 1h of predictions (they inflate totalPredictions forever, never
// reaching totalEvaluated). findUnsettledPredictions is the pure backfill/reschedule
// planner run from loadHistory() on restart.
describe('findUnsettledPredictions (issue #212E)', () => {
  const pred = (id, tsIso, price = 100, direction = 'up') => ({
    type: 'prediction',
    id,
    ts: tsIso,
    price,
    compositeScore: 20,
    compositeDirection: direction,
    timeframes: {},
    contract: null,
  });

  const outcome = (predictionId, window, tsIso, exitPrice = 105) => ({
    type: 'outcome',
    predictionId,
    window,
    ts: tsIso,
    exitPrice,
    compositeCorrect: true,
  });

  it('classifies a fully-settled prediction (all 4 windows have outcomes) as neither pending nor elapsed', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const records = [
      pred('p1', t0),
      outcome('p1', '1m', t0),
      outcome('p1', '5m', t0),
      outcome('p1', '15m', t0),
      outcome('p1', '1h', t0),
    ];
    const now = Date.parse(t0) + 2 * 3_600_000; // 2h later — well past every window
    const { pending, elapsed } = findUnsettledPredictions(records, now);
    assert.equal(pending.length, 0);
    assert.equal(elapsed.length, 0);
  });

  it('reschedules a still-open window as pending with the correct remaining time', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const records = [pred('p1', t0)];
    // 30s after prediction — the 1m window (60s) hasn't elapsed yet
    const now = Date.parse(t0) + 30_000;
    const { pending, elapsed } = findUnsettledPredictions(records, now);

    const oneMinPending = pending.find(p => p.windowMs === 60_000);
    assert.ok(oneMinPending, 'the 1m window should be pending');
    assert.equal(oneMinPending.remainingMs, 30_000);
    // The other 3 windows (5m/15m/1h) are also still open at t+30s
    assert.equal(pending.length, 4);
    assert.equal(elapsed.length, 0);
  });

  it('backfills an elapsed window using the earliest recorded price at/after the target time', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const targetTs = Date.parse(t0) + 60_000; // 1m window target
    const laterPredTs = new Date(targetTs + 5_000).toISOString(); // a later sample, 5s after target
    const records = [
      pred('p1', t0, 100),
      // A later prediction record (from the interval sampler) carries a `price` field
      // that doubles as historical price data for backfilling p1's elapsed window.
      pred('p2', laterPredTs, 108),
    ];
    const now = Date.parse(t0) + 10 * 60_000; // well past the 1m window
    const { elapsed } = findUnsettledPredictions(records, now);

    const oneMin = elapsed.find(e => e.prediction.id === 'p1' && e.windowMs === 60_000);
    assert.ok(oneMin, 'the 1m window for p1 should be elapsed');
    assert.equal(oneMin.exitPrice, 108, 'resolves to the nearest recorded price at/after the target time');
  });

  it('refuses to settle from a price observed before the target time', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const before = new Date(Date.parse(t0) - 120_000).toISOString();
    const after = new Date(Date.parse(t0) + 30_000).toISOString(); // later than p1, but still before its 1m target (60s)
    const records = [
      pred('before', before, 80),
      pred('p1', t0, 100), // the prediction under test — window target is t0+60s
      pred('after', after, 95), // the true "latest known price" before the outage swallowed the rest
    ];
    const now = Date.parse(t0) + 10 * 60_000; // well past every record — nothing exists at/after the target
    const { elapsed } = findUnsettledPredictions(records, now);
    const oneMin = elapsed.find(e => e.prediction.id === 'p1' && e.windowMs === 60_000);
    assert.equal(oneMin.exitPrice, null, 'a pre-target price is not a valid future settlement');
    assert.equal(oneMin.settlementTs, null);
  });

  it('returns exitPrice: null when no record carries a usable (truthy) price to backfill against', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    // A corrupted/malformed record with no valid price contributes nothing to the
    // price timeline. (In practice a prediction's own price is always truthy —
    // buildPrediction refuses to record a prediction without one — so this models
    // a genuinely corrupted JSONL row rather than a normal restart scenario.)
    const records = [{ ...pred('p1', t0, 0), price: 0 }];
    const now = Date.parse(t0) + 10 * 60_000;
    const { elapsed } = findUnsettledPredictions(records, now);
    const oneMin = elapsed.find(e => e.windowMs === 60_000);
    assert.equal(oneMin.exitPrice, null);
  });

  it('ignores neutral predictions (they were never scheduled for evaluation live either)', () => {
    const t0 = '2026-01-01T00:00:00.000Z';
    const records = [pred('p1', t0, 100, 'neutral')];
    const now = Date.parse(t0) + 10 * 60_000;
    const { pending, elapsed } = findUnsettledPredictions(records, now);
    assert.equal(pending.length, 0);
    assert.equal(elapsed.length, 0);
  });
});

// buildOutcomeRecord must produce an equivalent, correctly-scored outcome whether the
// exit price comes from a live feed or a historical backfill (issue #212E).
describe('buildOutcomeRecord backfill parity', () => {
  it('scores a backfilled outcome the same way a live evaluation would', () => {
    const prediction = {
      id: 'p1',
      ts: '2026-01-01T00:00:00.000Z',
      price: 100,
      compositeScore: 30,
      compositeDirection: 'up',
      timeframes: {},
      contract: null,
    };
    const outcome = buildOutcomeRecord(prediction, 60_000, 105); // +500 bps, well above the 1m noise floor
    assert.equal(outcome.compositeCorrect, true);
    assert.equal(outcome.predictionTs, prediction.ts);
    assert.equal(outcome.entryPrice, 100);
    assert.equal(outcome.exitPrice, 105);
  });
});
