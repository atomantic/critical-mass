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

// Restart never guesses that a lock from an interrupted maintainer is safe to
// steal. Operators must stop all writers before clearing that stale lock.
it('preserves a maintenance lock left by an interrupted process', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { acquireScorecardLock, lockPath } = require('../src/updown/scorecard-maintenance');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-restart-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(lockPath(directory));
  fs.writeFileSync(path.join(lockPath(directory), 'owner.json'), JSON.stringify({ pid: -1 }));
  assert.equal(acquireScorecardLock(directory), null);
  assert.equal(fs.existsSync(lockPath(directory)), true);
});

// A stale lock must degrade loudly instead of wedging writers forever: before
// the bound, scorecard.start() never resolved, so UpDown never began its cycles
// and the gateway shutdown drain always ran to its deadline.
describe('stale maintenance lock', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { withScorecardLock, lockPath } = require('../src/updown/scorecard-maintenance');
  const { createScorecard } = require('../src/updown/scorecard');

  const staleLock = (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-stale-lock-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(lockPath(directory));
    fs.writeFileSync(path.join(lockPath(directory), 'owner.json'), JSON.stringify({ pid: 4242, startedAt: '2026-01-01T00:00:00.000Z' }));
    return directory;
  };

  it('gives up waiting with the owner named, without running the write or stealing the lock', async (t) => {
    const directory = staleLock(t);
    let ran = false;
    await assert.rejects(
      withScorecardLock(directory, async () => { ran = true; }, { timeoutMs: 60 }),
      (err) => err.code === 'SCORECARD_LOCK_BUSY' && /owner pid 4242/.test(err.message),
    );
    assert.equal(ran, false);
    assert.equal(fs.existsSync(path.join(lockPath(directory), 'owner.json')), true);
  });

  it('lets scorecard startup finish by skipping retention', async (t) => {
    const directory = staleLock(t);
    const lines = [];
    const logger = { info: () => {}, warn: (message) => lines.push(message), error: (message) => lines.push(message) };
    const scorecard = createScorecard({
      io: { to: () => ({ emit: () => {} }) },
      lastPriceFn: () => 100,
      scorecardDir: directory,
      retentionLogger: logger,
      pruneLockWaitMs: 60,
    });
    t.after(() => scorecard.stop());

    await scorecard.start(() => ({ score: 0, type: 'NEUTRAL', confidence: 0, timeframes: {} }));

    assert.ok(lines.some((line) => line.includes('Scorecard prune failed') && line.includes('still held')));
    assert.equal(fs.existsSync(lockPath(directory)), true);
  });

  // Backups stop UpDown and then require every tracked write to drain within
  // 30s; a journal append parked on the lock for its full wait would fail them.
  it('cancels parked journal writes on stop so the pending-write drain completes', async (t) => {
    const directory = staleLock(t);
    const { drainPendingWrites } = require('../src/pending-writes');
    const scorecard = createScorecard({
      io: { to: () => ({ emit: () => {} }) },
      lastPriceFn: () => 100,
      journalWriter: (record, options) => withScorecardLock(directory, async () => {}, options),
    });

    scorecard.recordPrediction({ score: 20, type: 'BUY', confidence: 0.8, timeframes: {} }, 'signal_change');
    scorecard.stop();

    assert.equal((await drainPendingWrites(1000)).drained, true);
    const { journal } = scorecard.getMetrics();
    assert.equal(journal.healthy, false);
    assert.match(journal.lastError, /cancelled: writer stopped/);
    assert.equal(fs.existsSync(lockPath(directory)), true);
  });
});
