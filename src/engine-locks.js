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
 *
 * Ladder sweeps (#766) — rebuildLadder, cancelLadder, resetCycle's ladder
 * cancel, and the tick-driven ladder placement — serialise on a QUEUED,
 * reentrant ladder lock (withLadderLock): a second sweep waits for the first
 * to finish instead of cancelling its half-placed rungs underneath it. The
 * wait-for graph stays acyclic:
 *   - fill → merge (withFillGate, bounded) and fill → ladder (a TP close's
 *     resetCycle, bounded);
 *   - ladder holder → merge only (its own mid-cancel bookings pass the fill
 *     gate); a ladder holder never waits on fills — its nested calls, in its
 *     own async context, run through the ladder lock reentrantly;
 *   - merge → nothing: a caller inside a merge never waits on the ladder
 *     lock (it takes it only when free, otherwise runs unserialised).
 */
const { AsyncLocalStorage } = require('node:async_hooks');

/** How long a fill will poll for an in-flight merge before proceeding anyway. */
const FILL_WAIT_MS = 15000;
/** Poll interval while a fill waits for mergeInProgress to clear. */
const FILL_POLL_MS = 25;
/**
 * How long a caller waits for an in-flight ladder sweep before its timeout
 * policy applies. A full 30-rung rebuild (a bounded safeCancelOrder per rung —
 * ≤3 cancel acks or 6 status polls — then one placement per rung) finishes
 * well inside this; the bound only catches a hung exchange call.
 */
const LADDER_WAIT_MS = 180000;
/** Poll interval while a caller waits for the ladder lock. */
const LADDER_POLL_MS = 25;

const BUSY_STRUCTURE = 'A merge or reconcile is already in progress';
const BUSY_POSITION = 'A merge, reconcile, or fill is in progress — try again';
const BUSY_LADDER = 'A ladder rebuild, cancel, or cycle reset is in progress — try again';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.logWarn] - timeout warning sink
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.fillWaitMs]
 * @param {number} [opts.fillPollMs]
 * @param {number} [opts.ladderWaitMs]
 * @param {number} [opts.ladderPollMs]
 */
const createEngineLocks = (opts = {}) => {
  const logWarn = opts.logWarn || (() => {});
  const now = opts.now || Date.now;
  const sleep = opts.sleep || defaultSleep;
  const fillWaitMs = opts.fillWaitMs ?? FILL_WAIT_MS;
  const fillPollMs = opts.fillPollMs ?? FILL_POLL_MS;
  const ladderWaitMs = opts.ladderWaitMs ?? LADDER_WAIT_MS;
  const ladderPollMs = opts.ladderPollMs ?? LADDER_POLL_MS;

  let mergeInProgress = false;
  const mergeOwner = new AsyncLocalStorage();
  let reconcileInProgress = false;
  let fillInProgress = 0;
  let entryInProgress = false;
  // Ladder lock: `ladderTail` settles when the last queued holder releases;
  // `ladderPending` counts holders + waiters (0 ⇔ free). The ALS store is a
  // per-acquisition token, deactivated on release, so async work the holder
  // spawned and left running (a timer, a fire-and-forget booking) cannot
  // reenter a lock it no longer holds.
  let ladderTail = Promise.resolve();
  let ladderPending = 0;
  let ladderHolders = 0;
  const ladderOwner = new AsyncLocalStorage();

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
    const release = () => {
      reconcileInProgress = false;
    };
    // Observe both outcomes without creating an unhandled rejected cleanup
    // promise. Return the original result so the caller still owns its error.
    Promise.resolve(result).then(release, release);
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

  /** True while a ladder sweep holds the ladder lock or one is queued. */
  const isLadderBusy = () => ladderPending > 0;

  /**
   * Serialise a ladder sweep (#766). Queued, not refusing: a caller waits
   * (FIFO) for the in-flight holder, then runs `fn` holding the lock.
   * Reentrant: a call from inside the holder's own async context — e.g. a
   * rung that fills during the holder's cancel sweep, whose booking closes
   * the last body and runs resetCycle — runs `fn` directly, since waiting
   * would deadlock on itself.
   *
   * - `wait: false` — tick-driven callers: refuse instead of queueing.
   * - `onTimeout` — after ladderWaitMs: 'proceed' runs `fn` unserialised with
   *   a warning (a TP close must not be dropped); 'refuse' gives up with the
   *   busy result (an operator action can be retried).
   * - A caller inside a merge never waits (a merge must never wait on a
   *   holder whose own fills can wait on that merge): it takes the lock if
   *   free, otherwise runs `fn` unserialised with a warning.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @param {{wait?: boolean, onTimeout?: 'proceed' | 'refuse', label?: string, exchange?: string}} [opts]
   * @returns {Promise<T | {success: false, message: string}>}
   */
  const withLadderLock = async (fn, opts = {}) => {
    const held = ladderOwner.getStore();
    if (held && held.active) {
      return fn();
    }
    const { wait = true, onTimeout = 'proceed', label = 'ladder sweep', exchange = '?' } = opts;
    const busy = ladderPending > 0;
    if (busy && !wait) {
      return { success: false, message: BUSY_LADDER };
    }
    if (busy && mergeInProgress && mergeOwner.getStore()) {
      logWarn(`⚠️ [${exchange}] ${label} running inside a merge while a ladder sweep is in flight — not waiting (a merge never waits on the ladder lock)`);
      return fn();
    }

    const prev = ladderTail;
    /** @type {() => void} */
    let release = () => {};
    ladderTail = new Promise((resolve) => { release = resolve; });
    ladderPending++;

    let prevDone = !busy;
    if (busy) {
      prev.then(() => { prevDone = true; });
      const waitDeadline = now() + ladderWaitMs;
      while (!prevDone && now() < waitDeadline) {
        await sleep(ladderPollMs);
      }
      if (!prevDone) {
        if (onTimeout === 'refuse') {
          ladderPending--;
          // Keep later waiters queued behind the stuck holder, not behind us.
          prev.then(release);
          return { success: false, message: BUSY_LADDER };
        }
        logWarn(`⚠️ [${exchange}] ${label} proceeding after ${ladderWaitMs / 1000}s wait — ladder lock still held (possible stuck ladder sweep)`);
      }
    }

    const token = { active: true };
    ladderHolders++;
    try {
      return await ladderOwner.run(token, fn);
    } finally {
      token.active = false;
      ladderHolders--;
      ladderPending--;
      release();
    }
  };

  const getFlags = () => ({
    mergeInProgress,
    reconcileInProgress,
    fillInProgress,
    entryInProgress,
    ladderPending,
    ladderHolders,
  });

  return {
    withMergeLock,
    withFillGate,
    withReconcileLock,
    withEntryLock,
    withLadderLock,
    isMutatingStructure,
    isMutatingPosition,
    isEntryInProgress,
    isLadderBusy,
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
  LADDER_WAIT_MS,
  LADDER_POLL_MS,
  BUSY_LADDER,
};
