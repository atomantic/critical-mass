// @ts-check
/**
 * Regime-engine mutual-exclusion protocol.
 *
 * Serialises mutating operations (fills, merges, roll-ups, reconcile ticks,
 * entry evaluation, cycle resets, dust consolidation) so they cannot interleave
 * at an await and double-count or drop a body's qty/cost (#189, #196).
 *
 * Deadlock-freedom is structural: withMergeLock never consults the fill gate.
 * Fills wait (bounded) for an in-flight merge; a merge never waits on fills.
 *
 * Merge reentrancy uses AsyncLocalStorage so a nested call from the same
 * holder (collapse-all → per-body merge) runs through, while a concurrent
 * second holder is refused. A depth counter would treat overlapping awaits
 * as the same holder.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

/** How long a fill will poll for an in-flight merge before proceeding anyway. */
const FILL_WAIT_MS = 15000;
/** Poll interval while a fill waits for mergeInProgress to clear. */
const FILL_POLL_MS = 25;

const BUSY_STRUCTURE = 'A merge or reconcile is already in progress';
const BUSY_POSITION = 'A merge, reconcile, or fill is in progress — try again';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.logWarn] - timeout warning sink
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.fillWaitMs]
 * @param {number} [opts.fillPollMs]
 */
const createEngineLocks = (opts = {}) => {
  const logWarn = opts.logWarn || (() => {});
  const now = opts.now || Date.now;
  const sleep = opts.sleep || defaultSleep;
  const fillWaitMs = opts.fillWaitMs ?? FILL_WAIT_MS;
  const fillPollMs = opts.fillPollMs ?? FILL_POLL_MS;

  let mergeInProgress = false;
  const mergeOwner = new AsyncLocalStorage();
  let reconcileInProgress = false;
  let fillInProgress = 0;
  let entryInProgress = false;

  /**
   * True while a merge or reconcile is rewriting celestialBodies / TP orders.
   * Callers that themselves rewrite that structure (manual merge, collapse-all)
   * must refuse rather than interleave.
   */
  const isMutatingStructure = () => mergeInProgress || reconcileInProgress;

  /**
   * True while a merge, reconcile, or in-flight fill is mutating position
   * state. Callers that must not start mid-mutation (dust consolidate, cycle
   * reset) yield until the next tick.
   */
  const isMutatingPosition = () => isMutatingStructure() || fillInProgress > 0;

  /** True while an entry evaluation/placement holds the entry gate. */
  const isEntryInProgress = () => entryInProgress;

  /**
   * Operator-facing busy reason. `structure` matches merge/rollup refusals;
   * `position` matches cycle-reset refusals (includes in-flight fills).
   * @param {'structure' | 'position'} [scope='structure']
   */
  const describeBusy = (scope = 'structure') =>
    scope === 'position' ? BUSY_POSITION : BUSY_STRUCTURE;

  /**
   * Acquire the merge lock for `fn`. Reentrant: a nested call from the same
   * holder runs `fn` directly (collapse-all wrapping per-body merges).
   * Does not consult fillInProgress — a merge must never wait on fills.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @returns {Promise<T | {success: false, message: string}>}
   */
  const withMergeLock = async (fn) => {
    if (mergeOwner.getStore()) {
      return fn();
    }
    if (isMutatingStructure()) {
      return { success: false, message: describeBusy('structure') };
    }
    mergeInProgress = true;
    try {
      return await mergeOwner.run(true, fn);
    } finally {
      mergeInProgress = false;
    }
  };

  /**
   * Count this call as an in-flight fill and wait out an in-flight merge
   * (bounded) before running `fn`. Fills must not be dropped, so we wait
   * rather than skip. A stuck merge cannot hang a fill past fillWaitMs.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @param {{exchange?: string, orderId?: string}} [meta]
   */
  const withFillGate = async (fn, meta = {}) => {
    fillInProgress++;
    try {
      const waitDeadline = now() + fillWaitMs;
      while (mergeInProgress && now() < waitDeadline) {
        await sleep(fillPollMs);
      }
      if (mergeInProgress) {
        const exchange = meta.exchange || '?';
        const orderId = meta.orderId || '?';
        logWarn(
          `⚠️ [${exchange}] Fill ${orderId} proceeding after ${fillWaitMs / 1000}s wait — merge lock still held (possible stuck merge)`
        );
      }
      return await fn();
    } finally {
      fillInProgress--;
    }
  };

  /**
   * Take the reconcile lock, run `fn`, and release when its return value
   * settles (so fire-and-forget TP chains keep the lock until they finish).
   * Skips silently when a merge or reconcile is already running.
   * @template T
   * @param {() => T} fn
   * @returns {T | void}
   */
  const withReconcileLock = (fn) => {
    if (isMutatingStructure()) return;
    reconcileInProgress = true;
    let result;
    try {
      result = fn();
    } catch (err) {
      reconcileInProgress = false;
      throw err;
    }
    Promise.resolve(result).finally(() => {
      reconcileInProgress = false;
    });
    return result;
  };

  /**
   * Hold the entry gate across `fn`. Caller still checks isEntryInProgress
   * before the first await they care about; this only acquire/releases.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   */
  const withEntryLock = async (fn) => {
    entryInProgress = true;
    try {
      return await fn();
    } finally {
      entryInProgress = false;
    }
  };

  const getFlags = () => ({
    mergeInProgress,
    reconcileInProgress,
    fillInProgress,
    entryInProgress,
  });

  return {
    withMergeLock,
    withFillGate,
    withReconcileLock,
    withEntryLock,
    isMutatingStructure,
    isMutatingPosition,
    isEntryInProgress,
    describeBusy,
    getFlags,
    _test: {
      setMergeInProgress: (v) => { mergeInProgress = !!v; },
      setReconcileInProgress: (v) => { reconcileInProgress = !!v; },
      setFillInProgress: (v) => { fillInProgress = v; },
      setEntryInProgress: (v) => { entryInProgress = !!v; },
      getFlags,
    },
  };
};

module.exports = {
  createEngineLocks,
  FILL_WAIT_MS,
  FILL_POLL_MS,
};
