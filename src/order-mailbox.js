// @ts-check
/**
 * Generic async utilities behind the market data service's order handling: a
 * stop-aware timer tracker and a coalescing per-key work mailbox. Moved
 * verbatim out of market-data-service (issue #1975), which re-exports them.
 * Nothing here knows about orders, exchanges or the fill ledger.
 */
const { trackPendingWrite } = require('./pending-writes');

/**
 * Returns a setTimeout wrapper that tracks scheduled timer IDs so they
 * can all be cancelled on service stop. Used by createMarketDataService
 * to keep cancel-retry / untrack timers from firing against a stopped
 * service's stale fillLedger after a replacement service has taken over.
 *
 * cancelAll() does two things:
 *   1. clearTimeout() on every queued (not-yet-fired) timer ID.
 *   2. Sets a "stopped" flag. Any in-flight wrapped callback that has
 *      already begun executing checks the flag immediately on entry and
 *      bails out before invoking the user fn — preventing post-stop
 *      writes through the user callback (e.g. fillLedger.persist()
 *      inside a retry that fired right before stop()).
 *
 * @returns {{ trackedSetTimeout: Function, cancel: (id: ReturnType<typeof setTimeout>) => void, cancelAll: () => number, size: () => number, isStopped: () => boolean }}
 */
const createTimerTracker = () => {
  const pending = new Set();
  let stopped = false;
  const trackedSetTimeout = (fn, delay) => {
    // Refuse to schedule new timers once stopped. A callback firing just
    // before cancelAll can still await and then call trackedSetTimeout
    // again (e.g. settleCancelledOrder scheduling its next retry or the
    // untrack TTL). Without this no-op those post-stop timers would be
    // added after cancelAll cleared the set and could mutate the now-
    // stale service instance later.
    if (stopped) return null;
    let id;
    const wrapped = async () => {
      pending.delete(id);
      // After cancelAll(), an already-queued but not-yet-clearTimeout-able
      // callback could still fire (race between setTimeout firing and
      // cancelAll iterating). The stopped flag closes that window: the
      // callback bails before touching any service-instance state.
      if (stopped) return;
      await fn();
    };
    id = setTimeout(wrapped, delay);
    pending.add(id);
    return id;
  };
  const cancelAll = () => {
    const n = pending.size;
    stopped = true;
    for (const id of pending) clearTimeout(id);
    pending.clear();
    return n;
  };
  // Cancel a single pending timer by the id returned from trackedSetTimeout.
  // No-op if id is null/undefined or the timer has already fired/been cancelled.
  // Used by callers that need to re-arm a timer with a fresher delay (e.g.,
  // partial-retry rescheduling on a fresh WS update) without leaking the
  // stale timer into the pending set.
  const cancel = (id) => {
    if (id == null || !pending.has(id)) return;
    clearTimeout(id);
    pending.delete(id);
  };
  return { trackedSetTimeout, cancel, cancelAll, size: () => pending.size, isStopped: () => stopped };
};

// Service-wide cap on REST-backed order consumers running at once (#1026).
const ORDER_CONSUMER_CONCURRENCY = 4;

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/**
 * Coalescing per-key mailbox (issue #1026). Replaces a per-arrival promise
 * chain whose retained work grew with every WS update while a REST fetch
 * for the same order was in flight.
 *
 * Each key (orderId) owns at most:
 *   - one active pass (the batch of slots being consumed right now), and
 *   - one pending batch of named slots. Posting to a slot that is already
 *     pending REPLACES its work (and merges its payload when a `merge` is
 *     given) instead of queueing another closure, so tens of thousands of
 *     arrivals for one order retain a constant amount of work.
 *
 * Work for the same key never runs concurrently, and slots run in first-post
 * order within a pass — so partial / FILLED / CANCELLED handling stays
 * serialized (websocket-feed fire-and-forgets onOrderUpdate). A post that
 * lands while a pass is awaiting schedules exactly one further pass.
 *
 * Across keys, at most `concurrency` passes run at once; waiting keys sit in
 * an insertion-ordered Set, so each ready key appears once.
 *
 * Every caller posting to the same pending slot shares that slot's promise:
 * it resolves with the work's result or rejects with its error (one failing
 * slot never poisons the key — later posts run normally). Each key's
 * lifetime (first post → mailbox empty) is one pending-writes entry, so the
 * restore/backup drain can join it.
 *
 * stop() is final: pending slots resolve to undefined at once without
 * running, new posts resolve immediately, and an in-flight pass settles its
 * key once its current work returns. The returned promise is whenIdle().
 *
 * @param {{ concurrency?: number, label?: string }} [options]
 */
const createOrderMailbox = ({ concurrency = ORDER_CONSUMER_CONCURRENCY, label = 'market-order' } = {}) => {
  const boxes = new Map(); // key -> { slots: Map<slot, entry>, running, owner }
  const ready = new Set(); // keys waiting for a consumer
  let active = 0;
  let stopped = false;

  const dropPending = (box) => {
    for (const entry of box.slots.values()) entry.done.resolve(undefined);
    box.slots.clear();
  };

  const settleKey = (key, box) => {
    dropPending(box);
    boxes.delete(key);
    box.owner.resolve();
  };

  const runPass = async (box) => {
    const batch = box.slots;
    box.slots = new Map();
    for (const entry of batch.values()) {
      if (stopped) {
        entry.done.resolve(undefined);
        continue;
      }
      try {
        entry.done.resolve(await entry.run(entry.payload));
      } catch (err) {
        entry.done.reject(err);
      }
    }
  };

  const finishPass = (key, box) => {
    active -= 1;
    box.running = false;
    if (box.slots.size > 0 && !stopped) ready.add(key);
    else settleKey(key, box);
    pump();
  };

  const pump = () => {
    while (active < concurrency && ready.size > 0) {
      const key = ready.values().next().value;
      ready.delete(key);
      const box = boxes.get(key);
      if (!box) continue;
      active += 1;
      box.running = true;
      // Start on a microtask so a synchronous burst (one WS batch) merges
      // into this pass instead of forcing a second one.
      Promise.resolve().then(() => runPass(box)).then(() => finishPass(key, box));
    }
  };

  /**
   * @param {string} key
   * @param {string} slot - Work kind; re-posting a pending slot replaces it
   * @param {(payload: any) => any} run
   * @param {{ payload?: any, merge?: (pending: any, next: any) => any }} [options]
   * @returns {Promise<any>}
   */
  const post = (key, slot, run, { payload, merge } = {}) => {
    if (stopped) return Promise.resolve();
    let box = boxes.get(key);
    if (!box) {
      box = { slots: new Map(), running: false, owner: createDeferred() };
      boxes.set(key, box);
      trackPendingWrite(`${label}:${key}`, () => box.owner.promise);
    }
    const pending = box.slots.get(slot);
    if (pending) {
      pending.run = run;
      pending.payload = merge ? merge(pending.payload, payload) : payload;
      return pending.done.promise;
    }
    const entry = { run, payload, done: createDeferred() };
    box.slots.set(slot, entry);
    if (!box.running) {
      ready.add(key);
      pump();
    }
    return entry.done.promise;
  };

  // Resolves once every key accepted so far (and any work posted while it
  // settles) has released ownership — the join a writer handover (#1008)
  // and stop() wait on. Owner promises never reject.
  const whenIdle = async () => {
    while (boxes.size) await Promise.all([...boxes.values()].map((box) => box.owner.promise));
  };

  const stop = () => {
    stopped = true;
    ready.clear();
    for (const [key, box] of boxes) {
      // A running pass keeps ownership until its current await returns
      // (finishPass settles it); its queued callers resolve now.
      if (box.running) dropPending(box);
      else settleKey(key, box);
    }
    return whenIdle();
  };

  const stats = () => {
    let pendingSlots = 0;
    for (const box of boxes.values()) pendingSlots += box.slots.size;
    return { keys: boxes.size, pendingSlots, active, ready: ready.size };
  };

  return { post, stop, stats, whenIdle };
};

module.exports = {
  createTimerTracker,
  createOrderMailbox,
  ORDER_CONSUMER_CONCURRENCY,
};
