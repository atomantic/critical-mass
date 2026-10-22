'use strict';

/**
 * Placement-intent reconciliation for one fund.
 *
 * Decides what to do with persisted placement intents (orders dispatched whose
 * outcome was never recorded): adopt the real exchange order into normal
 * tracking, clear it when the exchange proves it never filled, or leave it
 * blocking placements. Extracted verbatim from regime-engine; the engine keeps
 * the engine-lock acquisition at its call sites (reconcileTick and the
 * `regime:reconcile-placement-intent` IPC handler).
 *
 * `getPositionState`, `getOrderExecutor` and `getAdapter` are accessors because
 * the engine reassigns those bindings (state reloads, executor swaps).
 */

const {
  getBlockingPlacementIntents,
  describePlacementIntents,
  isBlockingPlacementIntent,
  resolvePlacementIntent,
} = require('./state-tracker');
const { findPlacementOnExchange } = require('./placement-evidence');
const celestialHierarchy = require('./celestial-hierarchy');

// How often a fund that is blocked by an unresolved placement intent repeats
// the reason in its log (the guard itself is evaluated on every tick).
const PLACEMENT_BLOCK_LOG_INTERVAL_MS = 60_000;
// How long the engine-side intent check may be reused between ticker messages.
const PLACEMENT_INTENT_CACHE_MS = 1_000;
// How often one intent may be searched for in open orders and fill history.
const PLACEMENT_EVIDENCE_INTERVAL_MS = 5 * 60_000;

/**
 * @param {Object} deps
 * @param {string} deps.exchange
 * @param {string} deps.pair
 * @param {string} deps.productId
 * @param {boolean} deps.isDryRun
 * @param {() => Object} deps.getPositionState - Current position state (reassigned on reload)
 * @param {() => Object} deps.getOrderExecutor - Current order executor (swappable)
 * @param {() => Object} deps.getAdapter - Current exchange adapter
 * @param {Object} deps.fillLedger
 * @param {Object} deps.logger
 * @param {() => void} deps.saveLiveState
 * @returns {{reconcilePlacementIntent: Function, recoverPlacementIntent: Function, reconcilePendingPlacements: Function, blockingPlacementIntents: Function}}
 */
const createPlacementReconciler = ({
  exchange, pair, productId, isDryRun,
  getPositionState, getOrderExecutor, getAdapter,
  fillLedger, logger, saveLiveState,
}) => {
  // Rate limit for the "placements blocked by an unresolved intent" log line.
  let placementBlockLoggedAt = 0;
  // Short-lived cache of the intent check. evaluateEntryTrigger runs on every
  // ticker message, and the authoritative refusal is order-manager's own fresh
  // read immediately before each dispatch — so this can only delay the
  // engine-side skip (and the operator's unblock) by up to a second, never let
  // a duplicate order through.
  let placementIntentCache = { at: 0, intents: [] };
  // intentId -> last exchange-evidence search, bounding the fill-history scans.
  const placementEvidenceCheckedAt = new Map();

  /**
   * Unresolved placement intents for this fund, with rate-limited logging so a
   * blocked engine says why once a minute instead of once a tick.
   * @returns {Array<Object>} Blocking intents (empty when placements may proceed)
   */
  const blockingPlacementIntents = () => {
    if (isDryRun) return [];
    const now0 = Date.now();
    if (now0 - placementIntentCache.at < PLACEMENT_INTENT_CACHE_MS) return placementIntentCache.intents;

    const blocking = getBlockingPlacementIntents(exchange, pair);
    placementIntentCache = { at: now0, intents: blocking };
    if (blocking.length === 0) {
      placementBlockLoggedAt = 0;
      return blocking;
    }
    const now = Date.now();
    if (now - placementBlockLoggedAt > PLACEMENT_BLOCK_LOG_INTERVAL_MS) {
      placementBlockLoggedAt = now;
      const [oldest] = blocking;
      // Without a client order id, reconcilePendingPlacements matches open orders and fills instead.
      const resolution = oldest.clientOrderId
        ? 'awaiting automatic exchange reconciliation'
        : 'awaiting automatic reconciliation against exchange open orders and fills (no client order id)';
      logger.error(`⏸️ [${exchange}] New entries blocked — ${blocking.length} unresolved placement intent(s); oldest ${oldest.action ?? 'order'} ${oldest.id} ${resolution}`, {
        pendingIntents: blocking.length,
        intentId: oldest.id,
        action: oldest.action ?? null,
        clientOrderId: oldest.clientOrderId ?? null,
      });
    }
    return blocking;
  };

  // Null lookups may reflect bounded history rather than an absent order.
  const classifyAutomaticLookup = (found) => {
    if (!found) return 'absent';
    if (found.orderId && ['CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED'].includes(found.status)
      && found.filledSize === 0) return 'clear-unfilled-terminal';
    if (!['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REJECTED'].includes(found.status)) return 'status-unknown';
    return 'adoptable';
  };

  const adoptEntryPlacement = (intent, found) => {
    const positionState = getPositionState();
    const adopted = getOrderExecutor().adoptPlacement(found, intent);
    if (!positionState.pendingEntryOrders) positionState.pendingEntryOrders = [];
    if (!positionState.pendingEntryOrders.some(e => e.orderId === found.orderId)) {
      positionState.pendingEntryOrders.push({
        orderId: found.orderId,
        price: intent.price ?? 0,
        assetQty: intent.size ?? 0,
        sizeUsdc: intent.sizeUsdc ?? 0,
        placedAt: intent.createdAt ?? Date.now(),
        ...(Number.isFinite(intent.staleMs) && intent.staleMs > 0 ? { staleMs: intent.staleMs } : {}),
      });
    }
    return adopted;
  };

  const adoptLadderPlacement = (intent, found) => {
    const positionState = getPositionState();
    const adopted = getOrderExecutor().adoptPlacement(found, intent);
    positionState.pendingLadderOrders ||= [];
    if (!positionState.pendingLadderOrders.some(o => o.orderId === found.orderId)) {
      positionState.pendingLadderOrders.push({
        orderId: found.orderId, ladderIndex: intent.ladderIndex,
        price: intent.price ?? 0, assetQty: intent.size ?? 0,
        sizeUsdc: intent.sizeUsdc ?? 0, placedAt: intent.createdAt ?? Date.now(),
      });
    }
    positionState.ladderActive = true;
    positionState.ladderPlacedAt ||= intent.createdAt ?? Date.now();
    return adopted;
  };

  const placementBodySourceIds = (body) => {
    const sourceIds = new Set(body.sourceOrderIds || []);
    for (const buy of (body.buyOrders || [])) {
      if (buy.orderId && buy.orderId !== 'core-migration') sourceIds.add(buy.orderId);
    }
    return sourceIds;
  };

  const adoptBodyTpPlacement = (intent, found) => {
    const positionState = getPositionState();
    const body = (positionState.celestialBodies || []).find(b => b.id === intent.bodyId);
    if (!body) return { success: false, error: 'No position owner exists for this placement; the intent remains unresolved' };
    if (body.tpOrderId && body.tpOrderId !== found.orderId) return { success: false, error: 'The position already owns another TP; reconcile the exchange orders before adopting this placement' };
    const adopted = getOrderExecutor().adoptPlacement(found, intent);
    body.tpOrderId = found.orderId;
    body.tpPrice = intent.price ?? 0;
    body.assetOnOrder = intent.size ?? 0;
    celestialHierarchy.syncPositionState(positionState, positionState.celestialBodies);
    const sourceIds = placementBodySourceIds(body);
    fillLedger.annotateFillsByOrderIds(sourceIds, {
      sellOrderId: found.orderId, bodyId: body.id, bodyTier: body.tier,
    });
    return adopted;
  };

  const adoptLegacyTpPlacement = (intent, found) => {
    const positionState = getPositionState();
    if (positionState.activeTpOrderId && positionState.activeTpOrderId !== found.orderId) return { success: false, error: 'The position already owns another TP; reconcile the exchange orders before adopting this placement' };
    const adopted = getOrderExecutor().adoptPlacement(found, intent);
    positionState.activeTpOrderId = found.orderId;
    positionState.lastTpPrice = intent.price ?? 0;
    positionState.assetOnOrder = intent.size ?? 0;
    const sourceIds = new Set(fillLedger.getCurrentCycleFills()
      .filter(f => f.side === 'buy' && !f.isBodyOwned && !f.isSatellite && !f.bodyId && f.cycleAttribution !== 'timeframe')
      .map(f => f.orderId));
    fillLedger.annotateFillsByOrderIds(sourceIds, { sellOrderId: found.orderId });
    return adopted;
  };

  const placementAdopters = new Map([
    ['entry_bid', adoptEntryPlacement],
    ['entry_replacement', adoptEntryPlacement],
    ['ladder_entry', adoptLadderPlacement],
    ['body_tp', adoptBodyTpPlacement],
    ['take_profit', adoptLegacyTpPlacement],
    ['take_profit_taker', adoptLegacyTpPlacement],
    ['take_profit_replacement', adoptLegacyTpPlacement],
  ]);

  /** Remove an intent and drop every engine-side cache of it. */
  const releasePlacementIntent = (intentId) => {
    const removed = resolvePlacementIntent(exchange, pair, intentId);
    placementEvidenceCheckedAt.delete(intentId);
    placementIntentCache = { at: 0, intents: [] };
    return removed;
  };

  const discardPlacementIntent = (intentId, intent) => {
    const removed = releasePlacementIntent(intentId);
    if (!removed) return { success: false, error: `Placement intent ${intentId} was already resolved` };
    logger.warn(`🧹 [${exchange}] Operator discarded placement intent ${intentId} (${intent.action ?? 'order'}) — placements resume`, {
      intentId,
      action: intent.action ?? null,
      clientOrderId: intent.clientOrderId ?? null,
    });
    return { success: true, message: `Discarded ${intent.action ?? 'placement'} intent — placements resume for this fund` };
  };

  /** The blocking intent with this id, or undefined (in-flight dispatches are not reconcilable). */
  const findReconcilableIntent = (intentId) => describePlacementIntents(exchange, pair)
    .find(i => i.id === intentId && isBlockingPlacementIntent(i));

  const noReconcilableIntent = (intentId) => ({
    success: false,
    error: `No unresolved placement intent ${intentId} on this fund (an in-flight dispatch is not reconcilable)`,
  });

  /**
   * Authoritative client-order-id lookup. A rejected lookup resolves to
   * `{ lookupError }` so callers keep the intent instead of reading it as absent.
   * @returns {Promise<{found: Object|null}|{lookupError: Error}>}
   */
  const lookupPlacementByClientOrderId = (intent) => getAdapter().findOrderByClientOrderId(intent.clientOrderId, productId)
    .then(found => ({ found }), lookupError => ({ lookupError }));

  const lookupFailed = (lookupError) => ({
    success: false,
    error: `Lookup failed (${lookupError.message}) — the intent stays pending; we must not assume the order is absent`,
  });

  /**
   * Operator reconcile of one unresolved placement intent.
   *
   * `adopt` re-runs the authoritative client-order-id lookup and, only on a
   * positive find, adopts the real exchange order into normal tracking before
   * clearing the intent. `discard` clears an intent the operator has confirmed
   * never became a live order. Both are exactly-once: the disk row is removed
   * as part of the action, so a duplicate call finds nothing to act on.
   * @param {string} intentId - Intent id to reconcile
   * @param {'adopt'|'discard'} action - Operator decision
   * @returns {Promise<{success: boolean, message?: string, error?: string, adoptedOrderId?: string}>} Result
   */
  const reconcilePlacementIntent = async (intentId, action) => {
    if (action !== 'adopt' && action !== 'discard') {
      return { success: false, error: `Unknown reconcile action '${action}' (expected 'adopt' or 'discard')` };
    }
    const intent = findReconcilableIntent(intentId);
    if (!intent) return noReconcilableIntent(intentId);

    if (action === 'discard') return discardPlacementIntent(intentId, intent);

    if (!intent.clientOrderId) {
      return { success: false, error: 'This intent carries no client order id (the process died before the response), so it cannot be looked up. The engine searches open orders and fills for it automatically; otherwise check the exchange, cancel any duplicate, then discard it.' };
    }
    if (typeof getAdapter().findOrderByClientOrderId !== 'function') {
      return { success: false, error: `${exchange} cannot look up an order by client id; check the exchange manually, then discard the intent` };
    }

    const lookup = await lookupPlacementByClientOrderId(intent);
    if ('lookupError' in lookup) return lookupFailed(lookup.lookupError);
    if (!lookup.found) {
      return { success: false, error: `The exchange reports no order for client id ${intent.clientOrderId}. If you have confirmed that, discard the intent instead — an empty lookup alone is never auto-cleared.` };
    }
    return adoptFoundPlacement(intentId, intent, lookup.found, { automatic: false });
  };

  /**
   * Automatic recovery of one unresolved placement intent, run by the periodic
   * reconciler. Uses the same durable adoption path as the operator, and also
   * clears positively identified terminal orders with zero fills. When there is
   * no client order id, the adapter cannot look one up, or the lookup finds
   * nothing, it searches open orders and fill history instead
   * (resolveFromExchangeEvidence).
   * @param {string} intentId
   * @returns {Promise<{success: boolean, deferred?: boolean, message?: string, error?: string, adoptedOrderId?: string}>}
   */
  const recoverPlacementIntent = async (intentId) => {
    const intent = findReconcilableIntent(intentId);
    if (!intent) return noReconcilableIntent(intentId);

    if (!intent.clientOrderId || typeof getAdapter().findOrderByClientOrderId !== 'function') {
      return resolveFromExchangeEvidence(intentId, intent);
    }

    const lookup = await lookupPlacementByClientOrderId(intent);
    if ('lookupError' in lookup) return lookupFailed(lookup.lookupError);
    const classification = classifyAutomaticLookup(lookup.found);
    if (classification === 'clear-unfilled-terminal') return clearUnfilledTerminalIntent(intentId);
    if (classification === 'status-unknown') return { success: false, error: 'Exchange order status remains unknown; retrying automatically' };
    // An empty lookup may only reflect bounded history; corroborate it.
    if (classification === 'absent') return resolveFromExchangeEvidence(intentId, intent);
    return adoptFoundPlacement(intentId, intent, lookup.found, { automatic: true });
  };

  const clearUnfilledTerminalIntent = (intentId) => ({
    success: Boolean(releasePlacementIntent(intentId)),
    message: 'Exchange confirmed an unfilled terminal order; placements may resume',
  });

  /**
   * Orders and fills this fund already owns, so evidence matching only
   * considers exchange activity nobody here is tracking.
   * @returns {{isKnownOrder: (orderId: string) => boolean, isKnownTrade: (tradeId: string) => boolean}}
   */
  const ownedExchangeActivity = () => {
    const ledgerOrderIds = new Set(fillLedger.getAllFills().map(f => f.orderId));
    const pendingOrderIds = new Set(getOrderExecutor().getPendingOrdersList().map(o => o.orderId));
    return {
      isKnownOrder: (orderId) => pendingOrderIds.has(orderId) || ledgerOrderIds.has(orderId)
        || getOrderExecutor().isBodyTpOrder(orderId) || getOrderExecutor().isTrackedTpOrder(orderId),
      isKnownTrade: (tradeId) => fillLedger.hasProcessedTrade(tradeId),
    };
  };

  /**
   * Settle an intent the client-order-id lookup could not: search open orders
   * and fill history for the placement. A unique match is adopted, no match
   * clears the intent, and an ambiguous or failed search retries later.
   * @param {string} intentId
   * @param {Object} intent
   * @returns {Promise<{success: boolean, message?: string, error?: string, adoptedOrderId?: string}>}
   */
  const resolveFromExchangeEvidence = async (intentId, intent) => {
    const lastChecked = placementEvidenceCheckedAt.get(intentId) ?? 0;
    if (Date.now() - lastChecked < PLACEMENT_EVIDENCE_INTERVAL_MS) {
      return { success: false, deferred: true, error: 'Exchange evidence search ran recently; retrying automatically' };
    }
    placementEvidenceCheckedAt.set(intentId, Date.now());

    const evidence = await findPlacementOnExchange({ adapter: getAdapter(), productId, intent, ...ownedExchangeActivity() })
      .catch(err => ({ verdict: 'inconclusive', reason: `exchange search failed (${err.message})` }));
    if (evidence.verdict === 'inconclusive') {
      return { success: false, error: `Exchange evidence inconclusive: ${evidence.reason}; retrying automatically` };
    }
    if (!describePlacementIntents(exchange, pair).some(i => i.id === intentId)) {
      return { success: false, error: `Placement intent ${intentId} was already resolved` };
    }
    if (evidence.verdict === 'absent') {
      const removed = releasePlacementIntent(intentId);
      logger.warn(`🧹 [${exchange}] Cleared placement intent ${intentId} (${intent.action ?? 'order'}) — no matching open order or untracked fill on the exchange; placements resume`, {
        intentId,
        action: intent.action ?? null,
        clientOrderId: intent.clientOrderId ?? null,
        side: intent.side ?? null,
        price: intent.price ?? null,
        size: intent.size ?? null,
      });
      return { success: Boolean(removed), message: 'No matching order on the exchange; intent cleared' };
    }
    const classification = classifyAutomaticLookup(evidence.order);
    if (classification === 'clear-unfilled-terminal') return clearUnfilledTerminalIntent(intentId);
    if (classification === 'status-unknown') {
      return { success: false, error: `Matched exchange order ${evidence.order.orderId} but its status is unknown; retrying automatically` };
    }
    return adoptFoundPlacement(intentId, intent, evidence.order, { automatic: true });
  };

  /**
   * Adopt a positively identified exchange order into tracking, then clear its intent.
   * @param {string} intentId
   * @param {Object} intent
   * @param {Object} found - Exchange order (OrderDetails shape)
   * @param {{automatic: boolean}} origin - Recovery loop vs operator request (log wording only)
   * @returns {{success: boolean, message?: string, error?: string, adoptedOrderId?: string}}
   */
  const adoptFoundPlacement = (intentId, intent, found, { automatic }) => {
    // Recheck after the lookup await. From here through persistence and removal
    // there are no awaits, so concurrent operator requests cannot interleave.
    // Keep the intent until tracking reaches disk: a failed write must leave
    // placements blocked and allow this adoption to be retried.
    if (!describePlacementIntents(exchange, pair).some(i => i.id === intentId)) {
      return { success: false, error: `Placement intent ${intentId} was already resolved` };
    }

    if (!getOrderExecutor().capabilities?.liveReconciliation) {
      return { success: false, error: 'This executor cannot adopt orders; the placement intent remains unresolved' };
    }
    if (!found.orderId) return { success: false, error: 'Exchange lookup returned no order id; the placement intent remains unresolved' };
    const adopt = placementAdopters.get(intent.action);
    if (!adopt) return { success: false, error: 'No position owner exists for this placement; the intent remains unresolved' };
    const adopted = adopt(intent, found);
    if (adopted.success === false) return adopted;
    if (!isDryRun) {
      saveLiveState();
      fillLedger.persist();
    }
    releasePlacementIntent(intentId);

    logger.info(`ℹ️ ✅ [${exchange}] ${automatic ? 'Automatically adopted' : 'Operator adopted'} exchange order ${found.orderId} for placement intent ${intentId} (${intent.action ?? 'order'})`, {
      intentId,
      orderId: found.orderId,
      clientOrderId: intent.clientOrderId ?? null,
      action: intent.action ?? null,
      tracked: adopted.tracked,
    });
    return { success: true, adoptedOrderId: found.orderId, message: adopted.message };
  };

  // Run under the periodic reconciliation lock, before polling fills or TP
  // repair. Sequential lookups avoid bursts and cannot overlap another tick.
  const reconcilePendingPlacements = async () => {
    if (isDryRun) return;
    for (const intent of getBlockingPlacementIntents(exchange, pair)) {
      // An unparseable intent file is a disk problem, not an exchange question.
      if (intent.id === 'unreadable-intent-file') continue;
      try {
        const result = await recoverPlacementIntent(intent.id);
        if (!result.success && !result.deferred) logger.warn(`⏳ [${exchange}] Placement ${intent.id}: ${result.error}`);
      } catch (err) {
        logger.warn(`⏳ [${exchange}] Placement ${intent.id} recovery will retry: ${err.message}`);
      }
    }
  };

  return { reconcilePlacementIntent, recoverPlacementIntent, reconcilePendingPlacements, blockingPlacementIntents };
};

module.exports = { createPlacementReconciler };
