// @ts-check
const { createContextLogger } = require('./logger');
const { sleep } = require('./shared-utils');
const {
  getBlockingPlacementIntents,
  recordPlacementIntent,
  markPlacementIntentUnresolved,
  retainPlacementIntentInProcess,
  resolvePlacementIntent,
  deferPlacementIntentRemoval,
} = require('./placement-intent-storage');

/**
 * @typedef {import('./types').ExchangeAdapter} ExchangeAdapter
 * @typedef {import('./types').BuyResult} BuyResult
 * @typedef {import('./types').SellOrder} SellOrder
 */

/**
 * Build a context logger for a single placement operation. Same shape as the
 * order-manager helper of the same name; the `order-manager` module tag is kept
 * so log lines emitted by the relocated guard are unchanged.
 * @param {ExchangeAdapter|null} [adapter] - Exchange adapter (supplies the exchange name)
 * @param {string} [productId] - Trading pair being operated on
 * @returns {{info: (message: string, data?: Object) => void, warn: (message: string, data?: Object) => void, error: (message: string, data?: Object) => void}} Context logger
 */
const orderLogger = (adapter, productId) => createContextLogger({
  module: 'order-manager',
  exchange: adapter?.name,
  pair: productId,
});

/**
 * Terminal exchange statuses that cannot be adopted without execution. A
 * cancelled IOC can still have filled partially; that execution must be booked.
 */
const NON_ADOPTABLE_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED']);

/**
 * Whether a client-order-id lookup result is an order that reached the
 * exchange and still matters: live, filled, or terminal after a partial fill.
 * Anything else (absent, or terminal with nothing executed) is safe to re-place.
 * @param {{status?: string, filledSize?: number}|null} found - Lookup result
 * @returns {boolean} True when the order must be adopted rather than re-placed
 */
const isAdoptableOrder = (found) => !!found && (!NON_ADOPTABLE_STATUSES.has(found.status) || found.filledSize > 0);

/**
 * Place an order and, if the adapter reports an ambiguous 'unknown' outcome
 * (order-POST network error that may have reached the matching engine — issue
 * #199/#226), reconcile by client_order_id instead of treating it as a hard
 * failure. If the exchange shows a live/filled order carrying the deterministic
 * client_order_id we sent, adopt it (its orderId is real and must be tracked, or
 * we double-spend by re-buying). Only a genuinely-absent (or terminally-failed)
 * order is a true failure.
 *
 * A try/catch is unavoidable here: the adapter signals the unknown outcome by
 * throwing (so it can never be mistaken for a clean success), so the caller must
 * catch to reconcile. Non-unknown errors are re-thrown unchanged.
 *
 * The reconcile lookup retries with backoff (default 500ms/1s) if the first
 * attempt comes back empty — the exchange's order-history endpoint can be
 * briefly eventually-consistent right after the network error that produced
 * the unknown outcome, and declaring a real order absent too early lets a
 * caller re-place it against one that may still land (double exposure).
 * An outcome that CANNOT be reconciled — no client order id, no lookup
 * capability, or a lookup that itself failed — is no longer flattened into an
 * ordinary `{success:false}` (the shape callers read as "safe to re-place").
 * It is held PENDING against a durable placement intent, written to disk before
 * the POST was dispatched, and every later placement for that fund is refused
 * until an operator reconciles it — across restarts (#472).
 * @param {ExchangeAdapter} adapter - Exchange adapter
 * @param {string} productId - Product ID (scopes the reconcile lookup)
 * @param {() => Promise<BuyResult|SellOrder>} placeFn - Placement thunk
 * An accepted placement can be handed to its owner through `onAccepted` BEFORE
 * the dispatch intent is released (issue #963). The callback persists whatever
 * makes the caller own the order (e.g. a pending DCA buy record); only once it
 * returns is the intent cleared, so there is no window in which the accepted
 * order has neither record. If the callback throws, the intent is kept
 * blocking (in this process immediately, and on disk as unresolved with the
 * accepted order id) and a PENDING result is returned — never an ordinary
 * failure, because the exchange did accept the order.
 * @param {number[]|{retryDelaysMs?: number[], intent?: {exchange: string, pair?: string, action: string, side?: string, price?: number, size?: number, sizeUsdc?: number}|null, onAccepted?: ((placement: {orderId: string, clientOrderId?: string|null}) => void|Promise<void>)|null}} [options] - Backoff array (legacy positional form), or `{retryDelaysMs, intent, onAccepted}`. `intent` names the fund and the order being placed and turns on durable intent tracking; omit it only where no fund owns the placement (unit tests).
 * @returns {Promise<BuyResult|SellOrder|{success: false, pending: true, intentId: string|null, errorMessage: string, handoffFailed?: boolean, orderId?: string}>} Placement result (possibly reconciled, possibly pending)
 */
// Backoff between reconcile-lookup attempts when the first comes back empty —
// the exchange's order-history endpoint can be briefly eventually-consistent
// right after a network error on the placement POST, so a single immediate
// lookup risks declaring a real order absent and letting a caller re-place it
// (double exposure) purely because the lookup raced ahead of propagation.
const RECONCILE_RETRY_DELAYS_MS = [500, 1000];

/**
 * Accept either the legacy positional `retryDelaysMs` array or an options bag.
 * @param {number[]|{retryDelaysMs?: number[], intent?: Object|null}} [options] - Caller options
 * @returns {{retryDelaysMs?: number[], intent?: Object|null}} Normalized options
 */
const normalizePlaceOptions = (options) =>
  Array.isArray(options) ? { retryDelaysMs: options } : (options ?? {});

const placeWithUnknownReconcile = async (adapter, productId, placeFn, options = {}) => {
  const { retryDelaysMs = RECONCILE_RETRY_DELAYS_MS, intent: intentScope = null, onAccepted = null } = normalizePlaceOptions(options);
  const logger = orderLogger(adapter, productId);
  const exchange = intentScope?.exchange;
  const pair = intentScope?.pair;

  // ---------------------------------------------------------------------
  // 1. Refuse to dispatch while an earlier intent for this fund is unresolved.
  //    This is the durable half of the guard: the record lives on disk, so a
  //    restarted process refuses just as a running one does, and the refusal
  //    is central — it holds no matter which caller (entry, TP, ladder level,
  //    DCA buy, Fibonacci sell) reaches this funnel.
  // ---------------------------------------------------------------------
  if (intentScope) {
    const blocking = getBlockingPlacementIntents(exchange, pair);
    if (blocking.length > 0) {
      const [oldest] = blocking;
      const message = `unresolved placement intent ${oldest.id} (${oldest.action ?? 'order'}) must be reconciled by an operator before this fund places another order`;
      logger.error(`🚫 Placement refused — ${blocking.length} unresolved placement intent(s) on this fund; oldest is ${oldest.action ?? 'order'} ${oldest.id}`, {
        blockedByIntentId: oldest.id,
        blockedByAction: oldest.action ?? null,
        pendingIntents: blocking.length,
        clientOrderId: oldest.clientOrderId ?? null,
      });
      return { success: false, pending: true, blockedByIntentId: oldest.id, pendingIntents: blocking.length, errorMessage: message };
    }
  }

  // ---------------------------------------------------------------------
  // 2. Persist the intent BEFORE dispatch. A crash between the POST leaving
  //    this process and the response arriving would otherwise leave no record
  //    at all (entry tracking only starts on success), and the next tick would
  //    commit the same capital a second time. A persistence failure must
  //    therefore PREVENT the submission rather than be logged past.
  // ---------------------------------------------------------------------
  let intent = null;
  if (intentScope) {
    try {
      intent = recordPlacementIntent({ ...intentScope, productId });
    } catch (err) {
      logger.error(`🚫 Placement not submitted — could not persist the placement intent: ${err.message}`, {
        action: intentScope.action ?? null,
        error: err.message,
      });
      return { success: false, intentPersistenceFailed: true, errorMessage: `placement intent could not be persisted (${err.message}); order not submitted` };
    }
  }

  /** Drop the intent — the outcome is now definitively known. */
  const clearIntent = () => {
    if (intent) resolvePlacementIntent(exchange, pair, intent.id);
  };

  /**
   * Drop the intent, swallowing (never propagating) a failure to do so.
   * Clearing the intent is pure local housekeeping (a disk write) performed
   * AFTER the exchange-side outcome is already known — a disk-full/permission
   * failure here must never masquerade as a placement failure and cost the
   * caller a placement result (or a genuine rejection error) it already has.
   * The row is queued for deferred removal, retried on every blocking check
   * until the disk accepts the write. Without that, a restart would read the
   * leftover `dispatching` row as a dead process's dispatch and block the fund
   * with no client order id for automatic reconciliation to look up.
   * @param {string} context - Human label for what just happened, for the log line
   */
  const safeClearIntent = (context) => {
    try {
      clearIntent();
    } catch (clearErr) {
      if (intent) deferPlacementIntentRemoval(exchange, pair, intent.id);
      logger.error(`⚠️ Placement outcome resolved (${context}) but clearing its placement intent failed (${clearErr.message}) — removal will be retried automatically`, {
        context,
        error: clearErr.message,
        intentId: intent?.id ?? null,
      });
    }
  };

  /**
   * Keep the intent on disk and hand the caller a PENDING result. `success` is
   * still false (nothing may be tracked), but `pending` marks it as "not safe
   * to re-place" — and the disk record enforces that regardless of what the
   * caller does with the flag.
   * @param {string|undefined} clientOrderId - Id the placement carried, if known
   * @param {string} reason - Why the outcome could not be resolved
   * @returns {{success: false, pending: true, intentId: string|null, clientOrderId: string|null, errorMessage: string}} Pending result
   */
  const holdIntentPending = (clientOrderId, reason) => {
    if (intent) markPlacementIntentUnresolved(exchange, pair, intent.id, { clientOrderId: clientOrderId ?? null, reason });
    return { success: false, pending: true, intentId: intent?.id ?? null, clientOrderId: clientOrderId ?? null, errorMessage: reason };
  };

  /**
   * Hand an accepted order to its owner, then release the dispatch intent.
   * A handoff failure keeps the intent blocking and reports the placement as
   * pending — the exchange accepted it, so it is never a rejection.
   * @param {{orderId: string, clientOrderId?: string|null}} accepted - Accepted placement
   * @param {string} context - Human label for the clear, for the log line
   * @returns {Promise<Object>} The accepted placement, or a pending result
   */
  const handOffAccepted = async (accepted, context) => {
    if (typeof onAccepted === 'function') {
      try {
        await onAccepted(accepted);
      } catch (handoffErr) {
        const reason = `exchange accepted order ${accepted.orderId} but its ownership record could not be persisted (${handoffErr.message})`;
        if (intent) {
          retainPlacementIntentInProcess(intent.id);
          try {
            markPlacementIntentUnresolved(exchange, pair, intent.id, {
              clientOrderId: accepted.clientOrderId ?? null,
              orderId: accepted.orderId,
              reason,
            });
          } catch (markErr) {
            logger.error(`⚠️ Could not mark placement intent ${intent.id} unresolved (${markErr.message}) — it stays blocking in this process and blocks any restarted process`, {
              intentId: intent.id,
              orderId: accepted.orderId,
              error: markErr.message,
            });
          }
        }
        logger.error(`❌ Accepted order ${accepted.orderId} could not be handed off (${handoffErr.message}) — holding its placement intent; no replacement will be submitted until an operator reconciles`, {
          orderId: accepted.orderId,
          clientOrderId: accepted.clientOrderId ?? null,
          intentId: intent?.id ?? null,
          pending: true,
          error: handoffErr.message,
        });
        return {
          success: false,
          pending: true,
          handoffFailed: true,
          orderId: accepted.orderId,
          clientOrderId: accepted.clientOrderId ?? null,
          intentId: intent?.id ?? null,
          errorMessage: reason,
        };
      }
    }
    safeClearIntent(context);
    return accepted;
  };

  const dispatchedAt = Date.now();
  const placement = await placeFn().catch((err) => {
    // Only the ambiguous order-POST outcome is reconcilable; anything else
    // (validation errors, hard network failure on non-order POSTs) propagates.
    // Those are definitive — the exchange never took the order — so the intent
    // is cleared rather than left blocking the fund.
    if (err?.status === 'unknown' || err?.unknownOutcome === true) {
      return { __unknownError: err };
    }
    safeClearIntent('definitive rejection');
    throw err;
  });

  if (!placement?.__unknownError) {
    // Accepted, or cleanly rejected by the exchange — either way the outcome
    // is known and the intent has served its purpose. Clearing it is pure
    // housekeeping at this point (issue #710): if it throws — e.g. the
    // exchange genuinely accepted the order but the intent-file write then
    // hit a disk error — that must not cost the caller its successful
    // `placement`, so it's swallowed rather than allowed to escape here.
    if (placement?.success && placement.orderId) {
      return handOffAccepted(placement, 'accepted');
    }
    safeClearIntent('cleanly rejected');
    return placement;
  }

  const err = placement.__unknownError;
  const clientOrderId = err.clientOrderId;

  // Can't reconcile without the id or a lookup capability. This is the case
  // that used to return an ordinary failure — the shape callers read as "safe
  // to re-place next cycle" — while an accepted order may be resting live and
  // untracked. It now stays PENDING until an operator resolves it (#472).
  if (!clientOrderId || typeof adapter.findOrderByClientOrderId !== 'function') {
    logger.error(`❌ Unknown order outcome and cannot reconcile (clientOrderId=${clientOrderId ?? 'none'}) — holding the placement pending; no replacement will be submitted until an operator reconciles`, {
      clientOrderId: clientOrderId ?? null,
      reconcilable: false,
      pending: true,
      error: err.message,
    });
    return holdIntentPending(clientOrderId, err.message);
  }

  logger.warn(`⚠️ Unknown order outcome — reconciling by client_order_id ${clientOrderId}`, {
    clientOrderId,
    error: err.message,
  });
  let found = null;
  let lookupError = null;
  for (let attempt = 0; ; attempt++) {
    // A lookup that THROWS means "we could not check" — per the adapter
    // contract only a positive not-found returns null. Treating a failed check
    // as absence is the double-placement this whole path exists to prevent.
    found = await adapter.findOrderByClientOrderId(clientOrderId, productId, { placedAt: dispatchedAt }).catch((lookupErr) => {
      lookupError = lookupErr;
      return null;
    });
    if (lookupError || found || attempt >= retryDelaysMs.length) break;
    await sleep(retryDelaysMs[attempt]);
  }

  if (lookupError) {
    logger.error(`❌ Reconcile lookup for ${clientOrderId} failed (${lookupError.message}) — holding the placement pending; no replacement will be submitted until an operator reconciles`, {
      clientOrderId,
      pending: true,
      lookupError: lookupError.message,
      error: err.message,
    });
    return holdIntentPending(clientOrderId, `${err.message} — reconcile lookup failed: ${lookupError.message}`);
  }

  if (isAdoptableOrder(found)) {
    // The order DID reach the exchange — adopt it rather than re-place (which
    // would double-spend against the already-executing order). Clearing the
    // intent (after the owner's handoff) is what makes adoption exactly-once:
    // the row is gone, so no later recovery pass or operator action can adopt
    // the same order twice.
    const adopted = await handOffAccepted({ orderId: found.orderId, clientOrderId, success: true, reconciled: true }, 'reconciled adoption');
    if (!adopted.success) return adopted;
    logger.info(`ℹ️ ✅ Reconciled unknown placement — adopting exchange order ${found.orderId} (status ${found.status})`, {
      orderId: found.orderId,
      clientOrderId,
      status: found.status,
      reconciled: true,
    });
    return adopted;
  }

  // A positive not-found (adapter contract: null only on 404/OrderNotFound) or
  // a terminally-failed order is a DEFINITIVE outcome — the exchange never
  // holds a live order for this id, so the intent is cleared and the caller may
  // re-place on its next cycle.
  safeClearIntent('reconciled — not found live, safe to re-place');
  logger.warn(`❌ Unknown placement not found live on exchange (client_order_id ${clientOrderId}, status ${found?.status ?? 'absent'}) — treating as failed, safe to re-place next cycle`, {
    clientOrderId,
    status: found?.status ?? 'absent',
    error: err.message,
  });
  return { success: false, errorMessage: err.message };
};

module.exports = {
  placeWithUnknownReconcile,
  isAdoptableOrder,
};
