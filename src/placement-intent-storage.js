// @ts-check
// One process-local owner for intent identity, retention and deferred removals.
// Callers require this module directly; no facade re-exports it.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { resolveFundDataDir } = require('./fund-paths');
const { atomicWriteSync } = require('./durable-write');
const { tryOwnerDirectoryLock, waitForLock } = require('./file-lock');
const { PLACEMENT_INTENTS_FILENAME, parsePlacementIntentsDocument } = require('./placement-intent-document');

// ============================================================================
// Durable placement intents (issue #472)
// ============================================================================

/**
 * A placement intent is a durable record that we are ABOUT TO dispatch an order
 * POST. It is written before the request leaves the process and removed only
 * once the outcome is definitively known (accepted and tracked, or positively
 * rejected/never-received). Anything else — a crash inside the dispatch window,
 * an ambiguous outcome we could not reconcile — leaves the row on disk, and a
 * surviving row blocks every new placement for that fund until an operator
 * resolves it. That is what stops the next tick from committing the same
 * capital twice against an order that may already be live but untracked.
 *
 * Intents are stored per fund (exchange + pair), so an unresolved intent on one
 * fund never blocks another fund, and never stops monitoring, fill processing,
 * cancels or lifecycle operations on its own fund.
 */
const PLACEMENT_INTENT_STATUS = Object.freeze({
  /** Persisted pre-dispatch; the request may or may not have reached the exchange. */
  DISPATCHING: 'dispatching',
  /** Dispatched, outcome ambiguous, and reconciliation was impossible or inconclusive. */
  UNRESOLVED: 'unresolved',
});

/**
 * Identifies this process instance (regenerated on every module load, so a
 * restart — even one that reuses the pid — always gets a fresh value).
 *
 * A `dispatching` row stamped with OUR instance id is an in-flight placement
 * this process is still awaiting; it must not block a concurrent unrelated
 * placement in the same process (e.g. a TP sell while an entry bid is in the
 * air). A `dispatching` row stamped with any other instance id was written by a
 * process that died in the dispatch window — nothing will ever resolve it, so
 * it blocks immediately. Using instance identity rather than a wall-clock grace
 * period is deliberate: a crash-and-restart can complete in under a second, and
 * any age-based rule would wave that exact case through.
 */
const PROCESS_INSTANCE_ID = randomUUID();

/**
 * Get the placement-intent file path for a fund.
 * @param {string} [exchange] - Exchange name (default: coinbase)
 * @param {string} [pair] - Pair name; defaults to the exchange's default pair
 * @returns {string} Path to the placement intents file
 */
const getPlacementIntentsFile = (exchange = 'coinbase', pair) =>
  path.join(resolveFundDataDir(exchange, pair), PLACEMENT_INTENTS_FILENAME);

/**
 * Read every persisted placement intent for a fund.
 * @param {string} [exchange] - Exchange name
 * @param {string} [pair] - Pair name
 * @returns {Array<Object>} Persisted intents (empty when the file does not exist)
 */
const loadPlacementIntents = (exchange = 'coinbase', pair) => {
  const file = getPlacementIntentsFile(exchange, pair);
  if (!fs.existsSync(file)) return [];
  return parsePlacementIntentsDocument(fs.readFileSync(file, 'utf8'), file);
};

/**
 * Write the intent list for a fund (atomic rename, like every other state file).
 * @param {Array<Object>} intents - Intents to persist
 * @param {string} [exchange] - Exchange name
 * @param {string} [pair] - Pair name
 * @returns {void}
 */
const savePlacementIntents = (intents, exchange = 'coinbase', pair) => {
  const file = getPlacementIntentsFile(exchange, pair);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteSync(file, JSON.stringify({ version: 1, intents }, null, 2));
};

// The intents file is shared by the gateway and engine processes, and each
// mutation is load -> change -> atomic rewrite (with an fsync). Without a lock
// two processes interleaving in that window lose one writer's change. The lock
// is a directory (mkdir is atomic) beside the file; waiting is a synchronous
// sleep because every caller of the mutators is synchronous.
const INTENT_LOCK_TIMEOUT_MS = 10_000;
const INTENT_LOCK_STALE_MS = 30_000;
const INTENT_LOCK_POLL_MS = 5;

/**
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @returns {T}
 */
const withPlacementIntentsLock = (file, fn) => {
  const lock = `${file}.lock`;
  const release = waitForLock(
    () => tryOwnerDirectoryLock(lock, { ownerlessMs: INTENT_LOCK_STALE_MS, bestEffortRelease: true }),
    { waitMs: INTENT_LOCK_TIMEOUT_MS, pollMs: INTENT_LOCK_POLL_MS },
  );
  if (!release) throw new Error(`placement intents lock ${lock} still held after ${INTENT_LOCK_TIMEOUT_MS / 1000}s; refusing to write without it`);
  try { return fn(); } finally { release(); }
};

/**
 * Persist a pending placement intent BEFORE the order POST is dispatched.
 *
 * THROWS if the write fails, and the caller must let that propagate without
 * submitting: an order dispatched with no durable record is precisely the case
 * (crash between dispatch and response) this guards against.
 * @param {{exchange?: string, pair?: string, productId?: string, action?: string, side?: string, price?: number, size?: number, sizeUsdc?: number}} descriptor - What we are about to place
 * @returns {Object} The persisted intent (carries the generated `id`)
 */
const recordPlacementIntent = (descriptor) => {
  const { exchange = 'coinbase', pair, ...rest } = descriptor ?? {};
  const now = Date.now();
  const intent = {
    clientOrderId: null,
    reason: null,
    ...rest,
    id: randomUUID(),
    instanceId: PROCESS_INSTANCE_ID,
    status: PLACEMENT_INTENT_STATUS.DISPATCHING,
    exchange,
    pair: pair ?? null,
    createdAt: now,
    updatedAt: now,
  };

  withPlacementIntentsLock(getPlacementIntentsFile(exchange, pair), () => {
    savePlacementIntents([...loadPlacementIntents(exchange, pair), intent], exchange, pair);
  });
  return intent;
};

/**
 * Apply a patch to one persisted intent.
 * @param {string} exchange - Exchange name
 * @param {string|undefined} pair - Pair name
 * @param {string} intentId - Intent id
 * @param {Object} patch - Fields to merge
 * @returns {Object|null} Updated intent, or null when it no longer exists
 */
const updatePlacementIntent = (exchange, pair, intentId, patch) =>
  withPlacementIntentsLock(getPlacementIntentsFile(exchange, pair), () => {
    const intents = loadPlacementIntents(exchange, pair);
    const index = intents.findIndex(i => i?.id === intentId);
    if (index === -1) return null;

    const updated = intents.map((intent, i) => (i === index ? { ...intent, ...patch, updatedAt: Date.now() } : intent));
    savePlacementIntents(updated, exchange, pair);
    return updated[index];
  });

/**
 * Mark a dispatched intent as unresolved — the outcome was ambiguous and
 * reconciliation was impossible (no client order id, no lookup capability) or
 * inconclusive (the lookup itself failed). The row now blocks new placements
 * for this fund in EVERY process until an operator resolves it.
 * @param {string} exchange - Exchange name
 * @param {string|undefined} pair - Pair name
 * @param {string} intentId - Intent id
 * @param {{clientOrderId?: string|null, reason?: string|null, orderId?: string|null}} [details] - What we know about the dispatch
 * @returns {Object|null} Updated intent, or null when it no longer exists
 */
const markPlacementIntentUnresolved = (exchange, pair, intentId, details = {}) =>
  updatePlacementIntent(exchange, pair, intentId, {
    status: PLACEMENT_INTENT_STATUS.UNRESOLVED,
    clientOrderId: details.clientOrderId ?? null,
    reason: details.reason ?? null,
    ...(details.orderId ? { orderId: details.orderId } : {}),
  });

/**
 * Intent ids this process must treat as blocking even though their row may
 * still read as its own in-flight dispatch. Used when an accepted order's
 * handoff to its owner failed AND the follow-up write marking the row
 * unresolved may also have failed (e.g. the disk is refusing writes): without
 * this, the row would stay non-blocking for the rest of this process's life
 * and the fund could buy again on top of an order nobody owns (issue #963).
 * A restart needs no help — a foreign instance's dispatching row blocks.
 * @type {Set<string>}
 */
const retainedIntentIds = new Set();

/**
 * Keep an intent blocking in this process regardless of its persisted status.
 * Pure in-memory and cannot fail, so callers do it before attempting any write.
 * @param {string} intentId - Intent id to retain
 * @returns {void}
 */
const retainPlacementIntentInProcess = (intentId) => {
  if (intentId) retainedIntentIds.add(intentId);
};

/**
 * Remove an intent whose outcome is now definitively known.
 *
 * Returns null when the row was already gone. That no-op-on-second-call is what
 * makes adoption exactly-once: whoever removes the row owns the recovery, and a
 * duplicate callback (or a double-clicked operator reconcile) finds nothing.
 * @param {string} exchange - Exchange name
 * @param {string|undefined} pair - Pair name
 * @param {string} intentId - Intent id
 * @returns {Object|null} The removed intent, or null if it was already resolved
 */
const resolvePlacementIntent = (exchange, pair, intentId) =>
  withPlacementIntentsLock(getPlacementIntentsFile(exchange, pair), () => {
    const intents = loadPlacementIntents(exchange, pair);
    const removed = intents.find(i => i?.id === intentId);
    if (!removed) return null;

    savePlacementIntents(intents.filter(i => i?.id !== intentId), exchange, pair);
    retainedIntentIds.delete(intentId);
    return removed;
  });

/**
 * Intents whose outcome this process knows is definitive (accepted and handed
 * off, or rejected) but whose removal write failed — typically a full disk.
 * Left alone, the row reads as our own in-flight dispatch until the process
 * restarts, then as a foreign dispatch that blocks the fund until exchange
 * reconciliation searches for it, though this process already knew the outcome.
 * Removal is retried on every blocking check until a write succeeds.
 * @type {Map<string, {exchange: string, pair: string|null}>}
 */
const deferredIntentRemovals = new Map();

/**
 * Queue a definitively-resolved intent for removal once the disk accepts writes.
 * Pure in-memory and cannot fail, so callers do it after a failed removal.
 * @param {string} exchange - Exchange name
 * @param {string|undefined} pair - Pair name
 * @param {string} intentId - Intent id to remove later
 * @returns {void}
 */
const deferPlacementIntentRemoval = (exchange, pair, intentId) => {
  if (intentId) deferredIntentRemovals.set(intentId, { exchange, pair: pair ?? null });
};

/**
 * Retry queued removals for one fund. A write that still fails stays queued.
 * @param {string} exchange - Exchange name
 * @param {string|undefined} pair - Pair name
 * @returns {void}
 */
const flushDeferredIntentRemovals = (exchange, pair) => {
  for (const [intentId, fund] of deferredIntentRemovals) {
    if (fund.exchange !== exchange || fund.pair !== (pair ?? null)) continue;
    try {
      resolvePlacementIntent(exchange, pair, intentId);
      deferredIntentRemovals.delete(intentId);
    } catch {
      // Disk still refusing writes (or the file is unreadable); retry next check.
    }
  }
};

/**
 * Whether a persisted intent blocks new placements from THIS process.
 * @param {Object|null} intent - Persisted intent
 * @returns {boolean} True when the intent must block
 */
const isBlockingPlacementIntent = (intent) => {
  if (!intent) return false;
  if (retainedIntentIds.has(intent.id)) return true;
  // Our own in-flight dispatch is the only non-blocking shape. Anything else —
  // unresolved, a foreign instance's dispatch, an unrecognised status — blocks.
  return !(intent.status === PLACEMENT_INTENT_STATUS.DISPATCHING && intent.instanceId === PROCESS_INSTANCE_ID);
};

/**
 * Intents that must block any new placement for this fund right now.
 * A corrupt/unreadable intent file yields a synthetic blocking row rather than
 * throwing, so the caller fails closed (refuse to place) instead of crashing a
 * timer-driven tick — monitoring and fill processing keep running.
 * Retries any deferred removals for the fund first.
 * @param {string} [exchange] - Exchange name
 * @param {string} [pair] - Pair name
 * @returns {Array<Object>} Blocking intents
 */
const getBlockingPlacementIntents = (exchange = 'coinbase', pair) => {
  flushDeferredIntentRemovals(exchange, pair);
  let intents;
  try {
    intents = loadPlacementIntents(exchange, pair);
  } catch (err) {
    return [{
      id: 'unreadable-intent-file',
      status: PLACEMENT_INTENT_STATUS.UNRESOLVED,
      exchange,
      pair: pair ?? null,
      action: 'unknown',
      reason: err.message,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clientOrderId: null,
    }];
  }
  return intents.filter(isBlockingPlacementIntent);
};

/**
 * Operator-facing view of a fund's intents: every persisted row, annotated with
 * how old it is and whether it needs an operator. `needsAttention` is exactly
 * the blocking rule — a row the caller's process can still resolve by itself (a
 * placement it has in the air right now) is reported but not flagged, and
 * anything else is holding the fund's placements and needs a decision.
 * @param {string} [exchange] - Exchange name
 * @param {string} [pair] - Pair name
 * @param {number} [now] - Clock override for tests
 * @returns {Array<Object>} Annotated intents
 */
const describePlacementIntents = (exchange = 'coinbase', pair, now = Date.now()) => {
  let intents;
  try {
    intents = loadPlacementIntents(exchange, pair);
  } catch (err) {
    return [{
      id: 'unreadable-intent-file',
      status: PLACEMENT_INTENT_STATUS.UNRESOLVED,
      exchange,
      pair: pair ?? null,
      action: 'unknown',
      reason: err.message,
      createdAt: now,
      updatedAt: now,
      clientOrderId: null,
      ageMs: 0,
      needsAttention: true,
      recoveryHint: 'Repair or move aside the placement-intents.json file for this fund; placements stay blocked until it parses.',
    }];
  }

  return intents.map((intent) => ({
    ...intent,
    ageMs: Math.max(0, now - (intent?.createdAt ?? now)),
    needsAttention: isBlockingPlacementIntent(intent),
    recoveryHint: buildPlacementIntentHint(intent),
  }));
};

/**
 * Human recovery instruction for an unresolved intent.
 * @param {Object} intent - Persisted intent
 * @returns {string} Instruction for the operator
 */
const buildPlacementIntentHint = (intent) => {
  const what = `${intent?.side ?? 'order'} ${intent?.size ?? '?'} @ ${intent?.price ?? 'market'}`;
  return intent?.clientOrderId
    ? `The running engine automatically checks the exchange for client order id ${intent.clientOrderId} (${what}) and retries inconclusive lookups. Manual adoption or discard is available if automatic recovery cannot establish the outcome.`
    : `No client order id was recorded. A running regime engine searches the exchange's open orders and fills for ${what} placed around ${new Date(intent?.createdAt ?? Date.now()).toISOString()} and adopts or clears it automatically. If it stays unresolved, or this is a DCA fund, check the exchange yourself, cancel any duplicate, then discard this intent.`;
};

module.exports = {
  getPlacementIntentsFile,
  PLACEMENT_INTENT_STATUS,
  PROCESS_INSTANCE_ID,
  loadPlacementIntents,
  savePlacementIntents,
  recordPlacementIntent,
  updatePlacementIntent,
  markPlacementIntentUnresolved,
  retainPlacementIntentInProcess,
  resolvePlacementIntent,
  deferPlacementIntentRemoval,
  isBlockingPlacementIntent,
  getBlockingPlacementIntents,
  describePlacementIntents,
};
