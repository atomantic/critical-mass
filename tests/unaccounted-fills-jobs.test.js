// @ts-check
/**
 * Engine-owned Manual Trades unaccounted-fills scans (issue #966): start and
 * status answer promptly, a matching running scan is joined rather than
 * duplicated, concurrency and retention are bounded, and shutdown cancels.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createUnaccountedFillsJobs } = require('../src/unaccounted-fills-jobs');

/** A runner whose completion the test controls. */
const controllable = () => {
  let resolve;
  let reject;
  const calls = [];
  const run = (ctx) => {
    calls.push(ctx);
    return new Promise((res, rej) => { resolve = res; reject = rej; });
  };
  return { run, calls, resolve: (v) => resolve(v), reject: (e) => reject(e) };
};

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('unaccounted-fills scan jobs (issue #966)', () => {
  it('returns a quick complete result in one round trip', async () => {
    const jobs = createUnaccountedFillsJobs({ startWaitMs: 1000 });
    const status = await jobs.start('fund::1', async () => ({ success: true, unaccountedCount: 0, unaccountedOrders: [] }));
    assert.equal(status.success, true);
    assert.equal(status.pending, false);
    assert.equal(status.status, 'complete');
    assert.deepEqual(status.unaccountedOrders, []);
  });

  it('answers a long scan promptly with progress, then the complete result on status', async () => {
    const jobs = createUnaccountedFillsJobs({ startWaitMs: 0 });
    const runner = controllable();
    const started = await jobs.start('fund::1', runner.run);
    assert.equal(started.success, true);
    assert.equal(started.pending, true);
    assert.ok(started.jobId);
    assert.equal('unaccountedOrders' in started, false, 'no result while the scan is running');

    runner.calls[0].onProgress({ pages: 70, fills: 3, fraction: 0.25, cursorMs: 0, startMs: 0, endMs: 1, done: false });
    const mid = jobs.status(started.jobId);
    assert.equal(mid.pending, true);
    assert.equal(mid.progress.pages, 70);

    runner.resolve({ success: true, unaccountedCount: 1, unaccountedOrders: [{ orderId: 'o1' }] });
    await flush();
    const done = jobs.status(started.jobId);
    assert.equal(done.success, true);
    assert.equal(done.pending, false);
    assert.equal(done.status, 'complete');
    assert.deepEqual(done.unaccountedOrders, [{ orderId: 'o1' }]);
  });

  it('joins a matching running scan instead of launching a duplicate', async () => {
    const jobs = createUnaccountedFillsJobs({ startWaitMs: 0 });
    const runner = controllable();
    const a = await jobs.start('fund::1', runner.run);
    const b = await jobs.start('fund::1', runner.run);
    assert.equal(a.jobId, b.jobId);
    assert.equal(runner.calls.length, 1, 'only one exchange scan runs');
    for (let i = 0; i < 5; i++) jobs.status(a.jobId);
    assert.equal(runner.calls.length, 1, 'polling never starts a scan');
  });

  it('bounds concurrent scans', async () => {
    const jobs = createUnaccountedFillsJobs({ startWaitMs: 0, maxActive: 2 });
    const r1 = controllable();
    const r2 = controllable();
    const r3 = controllable();
    assert.equal((await jobs.start('fund::1', r1.run)).pending, true);
    assert.equal((await jobs.start('fund::2', r2.run)).pending, true);
    const refused = await jobs.start('fund::3', r3.run);
    assert.equal(refused.success, false);
    assert.match(refused.error, /Too many/);
    assert.equal(r3.calls.length, 0);

    r1.resolve({ success: true, unaccountedOrders: [] });
    await flush();
    assert.equal((await jobs.start('fund::3', r3.run)).pending, true, 'a slot frees once a scan finishes');
  });

  it('reports a genuine failure, and a fresh start after it runs a new scan', async () => {
    const jobs = createUnaccountedFillsJobs({ startWaitMs: 0 });
    const r1 = controllable();
    const started = await jobs.start('fund::1', r1.run);
    r1.reject(new Error('Crypto.com API 401: Unauthorized'));
    await flush();
    const failed = jobs.status(started.jobId);
    assert.equal(failed.success, false);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /401/);
    assert.equal('unaccountedOrders' in failed, false);

    const r2 = controllable();
    const again = await jobs.start('fund::1', r2.run);
    assert.notEqual(again.jobId, started.jobId);
    assert.equal(r2.calls.length, 1);

    // A structured {success:false} from the runner is a failure too.
    r2.resolve({ success: false, error: 'Failed to fetch trades: boom' });
    await flush();
    assert.match(jobs.status(again.jobId).error, /boom/);
  });

  it('expires finished jobs and bounds how many are retained', async () => {
    let now = 1_000;
    const jobs = createUnaccountedFillsJobs({ startWaitMs: 0, maxRetained: 2, retainMs: 60_000, now: () => now });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const s = await jobs.start(`fund::${i}`, async () => ({ success: true, unaccountedOrders: [] }));
      await flush();
      ids.push(s.jobId);
      now += 10;
    }
    assert.equal(jobs.size(), 2, 'only the newest finished jobs are retained');
    assert.equal(jobs.status(ids[0]).success, false);
    assert.match(jobs.status(ids[0]).error, /not found or expired/);
    assert.equal(jobs.status(ids[3]).success, true);

    now += 60_001;
    assert.equal(jobs.status(ids[3]).success, false, 'retained results expire');
    assert.equal(jobs.size(), 0);
  });

  it('cancels running scans on shutdown and refuses new ones', async () => {
    const jobs = createUnaccountedFillsJobs({ startWaitMs: 0 });
    const runner = controllable();
    const started = await jobs.start('fund::1', runner.run);
    const { signal } = runner.calls[0];
    assert.equal(signal.aborted, false);

    jobs.shutdown();
    assert.equal(signal.aborted, true, 'the exchange read is aborted');
    assert.equal(jobs.size(), 0);
    assert.equal(jobs.status(started.jobId).success, false);

    // A runner that ignores the signal and resolves late publishes nothing.
    runner.resolve({ success: true, unaccountedOrders: [{ orderId: 'late' }] });
    await flush();
    assert.equal(jobs.size(), 0);

    const refused = await jobs.start('fund::1', async () => ({ success: true }));
    assert.equal(refused.success, false);
    assert.match(refused.error, /shutting down/);
  });
});
