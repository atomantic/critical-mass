// @ts-check
/**
 * Engine-owned Manual Trades unaccounted-fills scans (issue #966).
 *
 * A full-history exchange read can outlast the gateway's ten-second IPC
 * deadline (a 252-day Crypto.com history is ~252 paced requests), so the
 * Manual Trades read runs as a background job inside the engine process and
 * the IPC/HTTP surface only ever answers "start" and "status" — both promptly.
 *
 * - A start for a fund + startDate that already has a RUNNING job returns that
 *   job instead of launching a second scan (polling and double-clicks never
 *   duplicate exchange traffic).
 * - At most `maxActive` scans run at once; further starts are refused.
 * - Finished jobs are retained for `retainMs`, at most `maxRetained` of them,
 *   so a poller can collect the result; older ones are evicted.
 * - `shutdown()` aborts every running scan and forgets all jobs; later starts
 *   are refused.
 *
 * A job reports `complete` only with the runner's complete result; a partial
 * traversal is never exposed as a result.
 */

const crypto = require('crypto');

const DEFAULT_MAX_ACTIVE = 2;
const DEFAULT_MAX_RETAINED = 8;
const DEFAULT_RETAIN_MS = 10 * 60 * 1000;
// A start waits this long for a quick scan to finish so short histories (and
// exchanges with cheap history reads) still answer in a single round trip.
// Must stay well below the IPC request deadline.
const DEFAULT_START_WAIT_MS = 2000;

/**
 * @typedef {import('./types').UnaccountedFillsJobStatus} UnaccountedFillsJobStatus
 * @typedef {import('./types').ReconciliationScanProgress} ReconciliationScanProgress
 *
 * @typedef {Object} UnaccountedFillsJob
 * @property {string} id
 * @property {string} key - fund + startDate identity used for reuse
 * @property {'running'|'complete'|'failed'|'cancelled'} status
 * @property {ReconciliationScanProgress|null} progress
 * @property {Object|null} result
 * @property {string|null} error
 * @property {number} startedAt
 * @property {number|null} finishedAt
 * @property {AbortController} controller
 * @property {Promise<void>} done
 */

/**
 * @param {Object} [options]
 * @param {number} [options.maxActive]
 * @param {number} [options.maxRetained]
 * @param {number} [options.retainMs]
 * @param {number} [options.startWaitMs]
 * @param {() => number} [options.now]
 * @param {{warn: (message: string, data?: Object) => void}} [options.logger]
 */
const createUnaccountedFillsJobs = (options = {}) => {
  const {
    maxActive = DEFAULT_MAX_ACTIVE,
    maxRetained = DEFAULT_MAX_RETAINED,
    retainMs = DEFAULT_RETAIN_MS,
    startWaitMs = DEFAULT_START_WAIT_MS,
    now = Date.now,
    logger = null,
  } = options;

  /** @type {Map<string, UnaccountedFillsJob>} */
  const jobs = new Map();
  let closed = false;

  const prune = () => {
    const cutoff = now() - retainMs;
    const finished = [];
    for (const job of jobs.values()) {
      if (job.status === 'running') continue;
      if ((job.finishedAt ?? 0) <= cutoff) jobs.delete(job.id);
      else finished.push(job);
    }
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    while (finished.length > maxRetained) {
      jobs.delete(/** @type {UnaccountedFillsJob} */ (finished.shift()).id);
    }
  };

  /**
   * @param {UnaccountedFillsJob} job
   * @returns {UnaccountedFillsJobStatus}
   */
  const describe = (job) => {
    const base = { jobId: job.id, status: job.status, progress: job.progress, startedAt: job.startedAt, finishedAt: job.finishedAt };
    if (job.status === 'running') return { success: true, pending: true, ...base };
    if (job.status === 'complete') return { ...job.result, success: true, pending: false, ...base };
    return { success: false, pending: false, ...base, error: job.error || 'Unaccounted-fills scan failed' };
  };

  const runningCount = () => [...jobs.values()].filter(j => j.status === 'running').length;

  /**
   * Start (or join) a scan.
   * @param {string} key - Identity of the request (fund + startDate)
   * @param {(ctx: {signal: AbortSignal, onProgress: (p: ReconciliationScanProgress) => void}) => Promise<Object>} run
   *   Performs the full read; resolves with `{success, ...}` (getUnaccountedFills shape)
   * @returns {Promise<UnaccountedFillsJobStatus>}
   */
  const start = async (key, run) => {
    if (closed) return { success: false, error: 'Engine is shutting down' };
    prune();
    const existing = [...jobs.values()].find(j => j.key === key && j.status === 'running');
    if (existing) return describe(existing);
    if (runningCount() >= maxActive) {
      return { success: false, error: `Too many unaccounted-fills scans in progress (max ${maxActive}); try again shortly` };
    }

    const controller = new AbortController();
    /** @type {UnaccountedFillsJob} */
    const job = {
      id: crypto.randomUUID(),
      key,
      status: 'running',
      progress: null,
      result: null,
      error: null,
      startedAt: now(),
      finishedAt: null,
      controller,
      done: Promise.resolve(),
    };
    jobs.set(job.id, job);

    const finish = (status, fields) => {
      if (job.status !== 'running') return;
      Object.assign(job, fields, { status, finishedAt: now() });
      prune();
    };

    job.done = Promise.resolve()
      .then(() => run({ signal: controller.signal, onProgress: (p) => { job.progress = p; } }))
      .then((result) => {
        if (controller.signal.aborted) return finish('cancelled', { error: 'Unaccounted-fills scan was cancelled' });
        if (result && result.success) return finish('complete', { result });
        return finish('failed', { error: result?.error || 'Unaccounted-fills scan failed' });
      }, (err) => {
        if (controller.signal.aborted) return finish('cancelled', { error: 'Unaccounted-fills scan was cancelled' });
        logger?.warn(`⚠️ Unaccounted-fills scan failed: ${err?.message}`, { error: err?.message });
        return finish('failed', { error: err?.message || String(err) });
      });

    if (startWaitMs > 0) {
      let timer;
      await Promise.race([
        job.done,
        new Promise(resolve => { timer = setTimeout(resolve, startWaitMs); }),
      ]);
      clearTimeout(timer);
    }
    return describe(job);
  };

  /**
   * @param {string} jobId
   * @returns {UnaccountedFillsJobStatus}
   */
  const status = (jobId) => {
    prune();
    const job = jobs.get(String(jobId || ''));
    if (!job) return { success: false, error: 'Unaccounted-fills scan not found or expired — start a new scan' };
    return describe(job);
  };

  /**
   * Abort every running scan and forget all jobs. Does not wait for the
   * runners: an adapter that ignores the signal must not stall shutdown, and
   * a cancelled job can never publish a result afterwards.
   */
  const shutdown = () => {
    closed = true;
    for (const job of jobs.values()) {
      if (job.status === 'running') {
        job.controller.abort();
        job.status = 'cancelled';
        job.error = 'Unaccounted-fills scan was cancelled';
        job.finishedAt = now();
      }
    }
    jobs.clear();
  };

  return { start, status, shutdown, size: () => jobs.size, runningCount };
};

module.exports = { createUnaccountedFillsJobs };
