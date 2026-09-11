// @ts-check
/**
 * Pending Gateway Writes
 *
 * The maintenance lock (`src/restore-maintenance.js`) stops NEW mutating work
 * from starting, but it says nothing about work that was already running when
 * the lock was taken. A scheduled DCA cycle that began one tick before a
 * restore keeps writing state files while the archive is being applied, so the
 * restored snapshot is silently partially overwritten.
 *
 * This module is the join point: every long-running gateway write registers
 * itself here, and the restore coordinator awaits the in-flight set before it
 * touches a single destination file (issue #429).
 *
 * A rejected operation still counts as drained — it is no longer writing.
 * Timing out does NOT: an operation we cannot observe finishing is treated the
 * same as a writer that never confirmed shutdown, and blocks the restore.
 */

/** @typedef {{label: string, startedAt: number, promise: Promise<any>}} PendingWrite */

/** @type {Set<PendingWrite>} */
const pending = new Set();

/**
 * Run an operation while it is visible to the drain.
 *
 * @template T
 * @param {string} label - Operator-facing name, e.g. `dca-cycle:coinbase`
 * @param {() => Promise<T>} run - The operation
 * @returns {Promise<T>} The operation's own result (rejections propagate unchanged)
 */
const trackPendingWrite = (label, run) => {
  /** @type {PendingWrite} */
  const entry = { label, startedAt: Date.now(), promise: Promise.resolve() };
  // `run` may throw synchronously before returning a promise; Promise.resolve()
  // .then keeps that on the rejection path instead of leaking an untracked throw.
  entry.promise = Promise.resolve().then(run).finally(() => {
    pending.delete(entry);
  });
  pending.add(entry);
  return entry.promise;
};

/**
 * @returns {Array<{label: string, runningMs: number}>} Snapshot of in-flight writes
 */
const getPendingWrites = () => [...pending].map((e) => ({ label: e.label, runningMs: Date.now() - e.startedAt }));

/**
 * Wait for every in-flight write to finish.
 *
 * @param {number} [timeoutMs] - How long to wait before giving up
 * @returns {Promise<{drained: boolean, pending: Array<{label: string, runningMs: number}>}>} Drain result
 */
const drainPendingWrites = async (timeoutMs = 30_000) => {
  const entries = [...pending];
  if (entries.length === 0) return { drained: true, pending: [] };

  /** @type {NodeJS.Timeout} */
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  // allSettled: a cycle that rejected has stopped writing, which is what we need.
  const settled = Promise.allSettled(entries.map((e) => e.promise)).then(() => true);

  const drained = await Promise.race([settled, expired]);
  clearTimeout(timer);

  return drained
    ? { drained: true, pending: [] }
    : { drained: false, pending: entries.filter((e) => pending.has(e)).map((e) => ({ label: e.label, runningMs: Date.now() - e.startedAt })) };
};

module.exports = { trackPendingWrite, getPendingWrites, drainPendingWrites };
