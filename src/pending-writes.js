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

const { AsyncLocalStorage } = require('node:async_hooks');

/** @typedef {{label: string, startedAt: number, promise: Promise<any>, parked: number}} PendingWrite */

/** @type {Set<PendingWrite>} */
const pending = new Set();
// The tracked writes enclosing the current async context, outermost first, so
// a writer that parks marks every write waiting on it (issue #1945).
/** @type {AsyncLocalStorage<PendingWrite[]>} */
const enclosingWrites = new AsyncLocalStorage();
// Drains waiting for a park/unpark to re-evaluate their cohort.
/** @type {Set<() => void>} */
const parkWaiters = new Set();
const notifyParkChange = () => {
  for (const wake of [...parkWaiters]) wake();
};

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
  const entry = { label, startedAt: Date.now(), promise: Promise.resolve(), parked: 0 };
  const chain = [...(enclosingWrites.getStore() || []), entry];
  // `run` may throw synchronously before returning a promise; Promise.resolve()
  // .then keeps that on the rejection path instead of leaking an untracked throw.
  entry.promise = Promise.resolve().then(() => enclosingWrites.run(chain, run)).finally(() => {
    pending.delete(entry);
  });
  pending.add(entry);
  return entry.promise;
};

/**
 * Wait on `released` as a PARKED writer: the current tracked write, and every
 * tracked write enclosing it, is writing nothing until `released` settles. A
 * backup drain excludes exactly these entries (see isParkedWrite), so a writer
 * queued behind a backup fence cannot stall the drain that fence exists for.
 * Writers that have passed the fence stay unparked and are still joined.
 * @param {Promise<unknown>} released
 * @returns {Promise<void>}
 */
const parkPendingWrites = async (released) => {
  const chain = enclosingWrites.getStore() || [];
  for (const entry of chain) entry.parked++;
  if (chain.length) notifyParkChange();
  try {
    await released;
  } finally {
    for (const entry of chain) entry.parked--;
    if (chain.length) notifyParkChange();
  }
};

/**
 * @param {PendingWrite} entry
 * @returns {boolean} Whether the write is parked behind a fence right now
 */
const isParkedWrite = (entry) => entry.parked > 0;

/**
 * @returns {Array<{label: string, runningMs: number}>} Snapshot of in-flight writes
 */
const getPendingWrites = () => [...pending].map((e) => ({ label: e.label, runningMs: Date.now() - e.startedAt }));

/**
 * Wait for every in-flight write to finish.
 *
 * @param {number} [timeoutMs] - How long to wait before giving up
 * @param {(entry: PendingWrite) => boolean} [matches] - Select a writer cohort, e.g. accepted IPC requests
 * @returns {Promise<{drained: boolean, pending: Array<{label: string, runningMs: number}>}>} Drain result
 */
const drainPendingWrites = async (timeoutMs = 30_000, matches = () => true) => {
  const entries = [...pending].filter(matches);
  if (entries.length === 0) return { drained: true, pending: [] };

  /** @type {NodeJS.Timeout} */
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    // This timer resolves an awaited drain; it must keep the process alive
    // even when the outstanding writer has no active event-loop handles.
  });
  // allSettled: a cycle that rejected has stopped writing, which is what we need.
  // A park/unpark re-evaluates the cohort: `matches` may select on isParkedWrite.
  const settled = (async () => {
    let batch = entries;
    while (batch.length) {
      /** @type {() => void} */
      let wake = () => {};
      const parkChanged = new Promise((resolve) => { wake = () => resolve(undefined); });
      parkWaiters.add(wake);
      try {
        await Promise.race([Promise.allSettled(batch.map((e) => e.promise)), parkChanged]);
      } finally {
        parkWaiters.delete(wake);
      }
      batch = [...pending].filter(matches);
    }
    return true;
  })();

  const drained = await Promise.race([settled, expired]);
  clearTimeout(timer);

  return drained
    ? { drained: true, pending: [] }
    : { drained: false, pending: [...pending].filter(matches).map((e) => ({ label: e.label, runningMs: Date.now() - e.startedAt })) };
};

module.exports = { trackPendingWrite, getPendingWrites, drainPendingWrites, parkPendingWrites, isParkedWrite };
