// @ts-check
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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

  it('reports failed retention deletions without counting or blocking later files', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scorecard-prune-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    const files = Array.from({ length: 32 }, (_, day) => `2026-01-${String(day + 1).padStart(2, '0')}.jsonl`);
    await Promise.all(files.map(file => fs.writeFile(path.join(dir, file), '')));
    const failedFile = files[0];
    const laterFile = files[1];
    const attempted = [];
    const lines = [];

    const scorecard = createScorecard({
      io: { to: () => ({ emit: () => {} }) },
      lastPriceFn: () => 100,
      scorecardDir: dir,
      unlinkFile: async file => {
        attempted.push(path.basename(file));
        if (path.basename(file) === failedFile) throw new Error('permission denied');
        await fs.unlink(file);
      },
      retentionLogger: (level, message) => lines.push(`${level} ${message}`),
    });

    await scorecard.start(() => ({ score: 0, type: 'NEUTRAL', confidence: 0, timeframes: {} }));
    scorecard.stop();

    assert.deepEqual(attempted, [failedFile, laterFile]);
    assert.equal(await fs.stat(path.join(dir, failedFile)).then(() => true), true);
    assert.equal(await fs.stat(path.join(dir, laterFile)).then(() => true, () => false), false);
    assert.ok(lines.some(line => line.includes('Scorecard prune completed deleted=1 failed=1 retentionDays=30')));
    assert.ok(lines.some(line => line.includes(`Scorecard prune failed err=failed to delete 1 scorecard file(s): ${failedFile}: permission denied`)));
  });
});
