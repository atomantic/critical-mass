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
 *
 * Backup fence (#1945): while a backup holds it (holdBackupFence), every NEW
 * top-level writer — fills, merges, entries, ladder sweeps, reconcile — parks
 * before taking any lock above, and the holder waits (bounded) for the writers
 * already past the fence to finish (waitForBackupIdle). Parking happens before
 * a lock is acquired and before a lock flag is set, and work nested in a
 * writer that already passed (its AsyncLocalStorage context) runs through, so
 * no writer the holder waits on can be waiting on a parked one. A parked
 * writer also marks its tracked pending writes parked, so the process-wide
 * backup drain skips exactly those and still joins everything else.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { sleep: defaultSleep } = require('./shared-utils');
const { parkPendingWrites } = require('./pending-writes');

/** How long a fill will poll for an in-flight merge before proceeding anyway. */
const FILL_WAIT_MS = 15000;
/**
 * How long engine shutdown waits for in-flight fill handlers to settle before
 * snapshotting state anyway. Must stay below the process-manager kill deadline
 * and the shutdown watchdog in engines/exchange-engine.js (which is derived
 * from this value).
 */
const FILL_DRAIN_MS = 10000;
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
const FILL_GATE_CLOSED_CODE = 'FILL_GATE_CLOSED';
const BUSY_LADDER = 'A ladder rebuild, cancel, or cycle reset is in progress — try again';

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
  // orderIds of fills currently inside withFillGate, for the shutdown timeout
  // warning. A Map keyed by a per-call token so duplicate orderIds stay counted.
  const inFlightFills = new Map();
  // Closed at shutdown: no NEW top-level fill may start, but a fill nested in
  // an in-flight handler (its AsyncLocalStorage context) still runs through.
  let fillGateClosed = false;
  const fillOwner = new AsyncLocalStorage();
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
  // Backup fence (#1945). `backupHold` is set while a backup owns the fund's
  // files; `fencedWriters` counts top-level writers that passed the fence. The
  // ALS token is per writer and deactivated when it finishes, so a timer or
  // fire-and-forget chain it left behind is fenced like any new writer.
  /** @type {{released: Promise<void>, release: () => void} | null} */
  let backupHold = null;
  let fencedWriters = 0;
  const fenceOwner = new AsyncLocalStorage();

  /** True when the current async context is a writer that passed the fence. */
  const insideBackupFence = () => fenceOwner.getStore()?.active === true;
  /** True when a backup holds the fence and the caller has not passed it. */
  const isBackupFenced = () => backupHold !== null && !insideBackupFence();

  /**
   * Run `fn` as a counted writer. Synchronous up to `fn`'s first await, so a
   * caller's check-then-set (the entry flag) stays atomic.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @returns {Promise<T>}
   */
  const runFenced = async (fn) => {
    if (insideBackupFence()) return fn();
    const token = { active: true };
    fencedWriters++;
    try {
      return await fenceOwner.run(token, fn);
    } finally {
      token.active = false;
      fencedWriters--;
    }
  };

  /**
   * Pass the backup fence, then run `fn` as a counted writer. A new top-level
   * writer parks while a backup holds the fence and runs once it is released;
   * a writer nested in one that already passed runs straight through.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @returns {Promise<T>}
   */
  const withBackupFence = async (fn) => {
    while (isBackupFenced()) {
      await parkPendingWrites(/** @type {NonNullable<typeof backupHold>} */ (backupHold).released);
    }
    return runFenced(fn);
  };

  /** Close the backup fence: new top-level writers park until release. Idempotent. */
  const holdBackupFence = () => {
    if (backupHold) return;
    /** @type {() => void} */
    let release = () => {};
    const released = new Promise((resolve) => { release = () => resolve(undefined); });
    backupHold = { released, release };
  };

  /** Reopen the backup fence; parked writers run in arrival order. Idempotent. */
  const releaseBackupFence = () => {
    const hold = backupHold;
    backupHold = null;
    hold?.release();
  };

  /**
   * Run synchronous `fn` as the fence holder itself (the backup's own flush),
   * so writes it makes are not deferred as fenced-out.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  const runAsBackupHolder = (fn) => {
    const token = { active: true };
    try {
      return fenceOwner.run(token, fn);
    } finally {
      token.active = false;
    }
  };

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
   * `position` matches cycle-reset refusals (includes in-flight fills);
   * `ladder` matches refusals while a ladder sweep holds the ladder lock.
   * @param {'structure' | 'position' | 'ladder'} [scope='structure']
   */
  const describeBusy = (scope = 'structure') => {
    if (scope === 'position') return BUSY_POSITION;
    if (scope === 'ladder') return BUSY_LADDER;
    return BUSY_STRUCTURE;
  };

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
    return withBackupFence(async () => {
      if (isMutatingStructure()) {
        return { success: false, message: describeBusy('structure') };
      }
      mergeInProgress = true;
      try {
        return await mergeOwner.run(true, fn);
      } finally {
        mergeInProgress = false;
      }
    });
  };

  /**
   * Count this call as an in-flight fill and wait out an in-flight merge
   * (bounded) before running `fn`. Fills must not be dropped, so we wait
   * rather than skip. A stuck merge cannot hang a fill past fillWaitMs.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @param {{exchange?: string, orderId?: string}} [meta]
   */
  const withFillGate = (fn, meta = {}) => withBackupFence(() => enterFillGate(fn, meta));
  /**
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @param {{exchange?: string, orderId?: string}} meta
   */
  const enterFillGate = async (fn, meta) => {
    if (fillGateClosed && !fillOwner.getStore()) {
      throw Object.assign(
        new Error(`Fill ${meta.orderId || '?'} refused — engine is shutting down; it will be recovered on next start`),
        { code: FILL_GATE_CLOSED_CODE }
      );
    }
    const token = {};
    fillInProgress++;
    inFlightFills.set(token, meta.orderId || '?');
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
      return await fillOwner.run(true, fn);
    } finally {
      fillInProgress--;
      inFlightFills.delete(token);
    }
  };

  /** Stop admitting new top-level fills (shutdown). Nested fills still run. */
  const closeFillGate = () => { fillGateClosed = true; };
  /** Re-admit fills (engine start after a stop). */
  const openFillGate = () => { fillGateClosed = false; };

  /** Writers and lock holders that keep a backup hold from confirming. */
  const backupBusy = () => [
    ...(fencedWriters > 0 ? [`${fencedWriters} writer(s)`] : []),
    ...(fillInProgress > 0 ? [`${fillInProgress} fill(s)`] : []),
    ...(mergeInProgress ? ['merge'] : []),
    ...(reconcileInProgress ? ['reconcile'] : []),
    ...(entryInProgress ? ['entry'] : []),
    ...(ladderPending > 0 ? ['ladder sweep'] : []),
  ];

  /**
   * Resolve once no writer that passed the backup fence is still running (and
   * no fill, merge, reconcile, entry or ladder holder is active), or at the
   * deadline. Never rejects: the caller fails the backup closed instead.
   * @param {number} [timeoutMs]
   * @returns {Promise<{idle: boolean, busy: string[], orderIds: string[]}>}
   */
  const waitForBackupIdle = async (timeoutMs = FILL_DRAIN_MS) => {
    const deadline = now() + timeoutMs;
    while (backupBusy().length && now() < deadline) {
      await sleep(fillPollMs);
    }
    const busy = backupBusy();
    return { idle: busy.length === 0, busy, orderIds: [...inFlightFills.values()] };
  };

  /**
   * Resolve once no fill is in flight, or at the deadline — never rejects, so
   * a hung fill handler cannot block shutdown past `timeoutMs`.
   * @param {number} [timeoutMs]
   * @returns {Promise<{idle: boolean, pending: number, orderIds: string[]}>}
   */
  const waitForFillsIdle = async (timeoutMs = FILL_DRAIN_MS) => {
    const deadline = now() + timeoutMs;
    while (fillInProgress > 0 && now() < deadline) {
      await sleep(fillPollMs);
    }
    return {
      idle: fillInProgress === 0,
      pending: fillInProgress,
      orderIds: [...inFlightFills.values()],
    };
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
    // A backup fence skips the tick like a busy lock: the next tick reconciles.
    if (isMutatingStructure() || isBackupFenced()) return;
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
   * before the first await they care about; this only acquire/releases, and
   * sets the flag synchronously. Under a backup fence the evaluation is
   * skipped (resolves undefined) rather than queued: entries are tick-driven,
   * and a queued check-then-set would let two of them pass the same check.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @returns {Promise<T | undefined>}
   */
  const withEntryLock = (fn) => {
    if (isBackupFenced()) return Promise.resolve(undefined);
    return runFenced(async () => {
      entryInProgress = true;
      try {
        return await fn();
      } finally {
        entryInProgress = false;
      }
    });
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
    // A tick-driven caller refuses under a backup fence, as when busy; any
    // other caller parks before it takes a queue slot.
    if (isBackupFenced() && opts.wait === false) {
      return { success: false, message: BUSY_LADDER };
    }
    return withBackupFence(() => enterLadderLock(fn, opts));
  };
  /**
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @param {{wait?: boolean, onTimeout?: 'proceed' | 'refuse', label?: string, exchange?: string}} opts
   * @returns {Promise<T | {success: false, message: string}>}
   */
  const enterLadderLock = async (fn, opts) => {
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

    let proceededPastHolder = false;
    if (busy) {
      let prevDone = false;
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
        proceededPastHolder = true;
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
      // Having run alongside a stuck holder, hand the lock on only once that
      // holder is done too — later waiters must not skip past it silently.
      if (proceededPastHolder) prev.then(release);
      else release();
    }
  };

  const getFlags = () => ({
    mergeInProgress,
    reconcileInProgress,
    fillInProgress,
    entryInProgress,
    ladderPending,
    ladderHolders,
    fencedWriters,
    backupFenceHeld: backupHold !== null,
  });

  return {
    withMergeLock,
    withFillGate,
    closeFillGate,
    openFillGate,
    waitForFillsIdle,
    withBackupFence,
    holdBackupFence,
    releaseBackupFence,
    isBackupFenced,
    isBackupFenceHeld: () => backupHold !== null,
    waitForBackupIdle,
    runAsBackupHolder,
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
  FILL_DRAIN_MS,
  FILL_GATE_CLOSED_CODE,
  LADDER_WAIT_MS,
  LADDER_POLL_MS,
  BUSY_LADDER,
};
