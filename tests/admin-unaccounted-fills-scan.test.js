// @ts-check
/**
 * Manual Trades polling of the engine-owned unaccounted-fills scan
 * (issue #966): one start, status-only polling, progress, the complete
 * result or a genuine failure, and cancellation.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
before(async () => {
  mod = await import(pathToFileURL(path.join(__dirname, '..', 'admin', 'src', 'utils', 'unaccountedFillsScan.mjs')).href);
});

/** Fake gateway: a queue of responses per URL kind. */
const fakeGateway = (startBody, statusBodies) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/unaccounted-fills/jobs/')) {
      const next = statusBodies.shift();
      if (next instanceof Error) throw next;
      return { json: async () => next };
    }
    return { json: async () => startBody };
  };
  return { calls, fetchImpl };
};

const sleep = async () => {};

describe('runUnaccountedFillsScan (issue #966)', () => {
  it('returns an immediately complete result without polling', async () => {
    const gw = fakeGateway({ success: true, pending: false, unaccountedOrders: [{ orderId: 'a' }] }, []);
    const out = await mod.runUnaccountedFillsScan({ exchange: 'cryptocom', pairQuery: '?pair=CRO_USD', startDate: '2026-01-01', fetchImpl: gw.fetchImpl, sleep });
    assert.equal(out.status, 'complete');
    assert.deepEqual(out.data.unaccountedOrders, [{ orderId: 'a' }]);
    assert.deepEqual(gw.calls, ['/api/cryptocom/regime/unaccounted-fills?pair=CRO_USD&startDate=2026-01-01']);
  });

  it('polls status only, reports progress, and returns the complete result', async () => {
    const gw = fakeGateway(
      { success: true, pending: true, jobId: 'job-1', progress: null },
      [
        { success: true, pending: true, jobId: 'job-1', progress: { fraction: 0.4, pages: 100 } },
        new Error('Failed to fetch'), // transient gateway hiccup
        { success: true, pending: true, jobId: 'job-1', progress: { fraction: 0.9, pages: 230 } },
        { success: true, pending: false, jobId: 'job-1', status: 'complete', unaccountedOrders: [{ orderId: 'old' }] },
      ],
    );
    const progress = [];
    const out = await mod.runUnaccountedFillsScan({
      exchange: 'cryptocom', pairQuery: '', startDate: '2026-01-01', fetchImpl: gw.fetchImpl, sleep, onProgress: p => progress.push(p),
    });
    assert.equal(out.status, 'complete');
    assert.deepEqual(out.data.unaccountedOrders, [{ orderId: 'old' }]);
    assert.equal(gw.calls.filter(u => !u.includes('/jobs/')).length, 1, 'exactly one start request');
    assert.ok(gw.calls.slice(1).every(u => u === '/api/cryptocom/regime/unaccounted-fills/jobs/job-1'));
    assert.deepEqual(progress.map(p => p?.pages ?? null), [null, 100, 100, 230]);
    assert.equal(mod.describeScanProgress({ fraction: 0.9, pages: 230 }), 'Scanning exchange history... 90%, 230 pages');
  });

  it('surfaces a genuine scan failure', async () => {
    const gw = fakeGateway(
      { success: true, pending: true, jobId: 'job-2' },
      [{ success: false, status: 'failed', jobId: 'job-2', error: 'Failed to fetch trades: Crypto.com API 401: Unauthorized' }],
    );
    const out = await mod.runUnaccountedFillsScan({ exchange: 'cryptocom', pairQuery: '', startDate: '2026-01-01', fetchImpl: gw.fetchImpl, sleep });
    assert.equal(out.status, 'failed');
    assert.match(out.error, /401/);
  });

  it('gives up after repeated status transport failures', async () => {
    const gw = fakeGateway({ success: true, pending: true, jobId: 'job-3' }, [new Error('a'), new Error('b'), new Error('c')]);
    const out = await mod.runUnaccountedFillsScan({ exchange: 'cryptocom', pairQuery: '', startDate: '2026-01-01', fetchImpl: gw.fetchImpl, sleep });
    assert.equal(out.status, 'failed');
  });

  it('stops polling once the caller cancels', async () => {
    let cancelled = false;
    const gw = fakeGateway({ success: true, pending: true, jobId: 'job-4' }, [{ success: true, pending: true, jobId: 'job-4' }]);
    const out = await mod.runUnaccountedFillsScan({
      exchange: 'cryptocom', pairQuery: '', startDate: '2026-01-01', fetchImpl: gw.fetchImpl,
      sleep: async () => { cancelled = true; }, isCancelled: () => cancelled,
    });
    assert.equal(out.status, 'cancelled');
    assert.equal(gw.calls.length, 1, 'no status read after cancellation');
  });
});
