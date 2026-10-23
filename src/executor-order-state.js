// @ts-check
/**
 * Per-executor order tracking, composed by live placement and dry-run simulation.
 * No exchange IO, timers, fill accounting or durable state belongs here.
 */
const { createOrderLookups } = require('./executor-contract');

const SETTLED_TTL_MS = 5 * 60 * 1000;

/**
 * Live views include every tracked order and remember settled core TPs. Dry-run
 * views include only open orders (but total remains the map size), and external
 * fill notifications do nothing because simulation owns fills and analytics.
 * @param {{mode: 'live'|'dry-run', onUntrackedFill?: (orderId: string) => void}} options
 */
const createExecutorOrderState = ({ mode, onUntrackedFill = () => {} }) => {
  const live = mode === 'live';
  /** @type {Map<string, any>} */
  const pendingOrders = new Map();
  /** @type {Map<string, any>} */
  const bodyTpOrders = new Map();
  /** Live reverse index retains the existing O(1) lookup and cleanup semantics. */
  const tpOrderToKey = new Map();
  const coreTp = { activeTpOrderId: /** @type {string|null} */ (null), lastTpPrice: 0, lastTpSize: 0 };

  // Live polling/cancel paths settle before routing their fill to the engine.
  // Remember those ids so duplicate cleanup is not mistaken for an orphan.
  const recentlySettled = new Map();
  const recentlySettledTps = new Map();
  const pruneSettled = (map) => {
    if (map.size > 256) {
      const cutoff = Date.now() - SETTLED_TTL_MS;
      for (const [id, ts] of map) if (ts < cutoff) map.delete(id);
    }
  };
  /** @param {string} orderId @param {string} [type] */
  const markSettled = (orderId, type) => {
    if (!live || !orderId) return;
    recentlySettled.set(orderId, Date.now());
    pruneSettled(recentlySettled);
    if (type === 'take_profit') {
      recentlySettledTps.set(orderId, Date.now());
      pruneSettled(recentlySettledTps);
    }
  };

  const visible = (order) => live || order.status === 'open';
  const getPendingCounts = () => {
    let entries = 0;
    let ladderEntries = 0;
    let takeProfits = 0;
    let bodies = 0;
    for (const order of pendingOrders.values()) {
      if (!visible(order)) continue;
      if (order.type === 'entry') entries++;
      else if (order.type === 'ladder_entry') ladderEntries++;
      else if (order.type === 'take_profit') takeProfits++;
      else if (order.type === 'body_tp') bodies++;
    }
    return { entries, ladderEntries, takeProfits, bodies, total: pendingOrders.size };
  };
  const getPendingEntries = () => {
    const entries = new Map();
    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'entry' && visible(order)) entries.set(orderId, order);
    }
    return entries;
  };
  const getPendingLadderOrders = () => {
    const orders = [];
    for (const [orderId, order] of pendingOrders) {
      if (order.type === 'ladder_entry' && visible(order)) {
        orders.push({ orderId, price: order.price, size: order.size, sizeUsdc: order.sizeUsdc,
          ladderIndex: order.ladderIndex, placedAt: order.placedAt });
      }
    }
    return orders.sort((a, b) => b.price - a.price);
  };

  const trackBodyTp = (bodyId, body) => {
    bodyTpOrders.set(bodyId, body);
    if (live) tpOrderToKey.set(body.tpOrderId, bodyId);
  };
  // Does not remove pending tracking: a filled live cancellation retains it for polling.
  const deleteBodyTp = (bodyId, orderId) => {
    bodyTpOrders.delete(bodyId);
    if (live) tpOrderToKey.delete(orderId);
  };
  const bodyIdForOrder = (orderId) => {
    if (live) return tpOrderToKey.get(orderId);
    for (const [bodyId, body] of bodyTpOrders) {
      if (body.tpOrderId === orderId) return bodyId;
    }
    return undefined;
  };
  const isBodyTpOrder = (orderId) => {
    if (live) return tpOrderToKey.has(orderId);
    for (const body of bodyTpOrders.values()) {
      if (body.tpOrderId === orderId) return true;
    }
    return false;
  };
  const getBodyByTpOrderId = (orderId) => {
    const bodyId = bodyIdForOrder(orderId);
    if (live ? !bodyId : bodyId === undefined) return null;
    const body = bodyTpOrders.get(bodyId);
    return body ? { bodyId, ...body } : null;
  };
  const removeBodyTracking = (orderId) => {
    const bodyId = bodyIdForOrder(orderId);
    if (live ? !bodyId : bodyId === undefined) return;
    deleteBodyTp(bodyId, orderId);
    pendingOrders.delete(orderId);
  };

  const clearCoreTp = () => {
    coreTp.activeTpOrderId = null;
    coreTp.lastTpPrice = 0;
    coreTp.lastTpSize = 0;
  };
  const isTrackedTpOrder = (orderId) => {
    if (!orderId) return false;
    if (orderId === coreTp.activeTpOrderId) return true;
    if (pendingOrders.get(orderId)?.type === 'take_profit') return true;
    const ts = recentlySettledTps.get(orderId);
    return live && ts !== undefined && Date.now() - ts < SETTLED_TTL_MS;
  };
  const handleOrderFill = (orderId) => {
    if (!live) return;
    const order = pendingOrders.get(orderId);
    if (order) {
      pendingOrders.delete(orderId);
      markSettled(orderId, order.type);
      // Live fill cleanup intentionally resets core identity even if another TP
      // is active, matching its existing notification behavior.
      if (order.type === 'take_profit') clearCoreTp();
      else if (order.type === 'body_tp') removeBodyTracking(orderId);
    } else if (!recentlySettled.has(orderId)) {
      onUntrackedFill(orderId);
    }
  };
  const handleOrderCancel = (orderId) => {
    const order = pendingOrders.get(orderId);
    if (!order) return;
    if (!live) order.status = 'cancelled';
    pendingOrders.delete(orderId);
    if (order.type === 'take_profit' && orderId === coreTp.activeTpOrderId) clearCoreTp();
    else if (order.type === 'body_tp') removeBodyTracking(orderId);
  };

  return {
    pendingOrders, bodyTpOrders, coreTp, orderLookups: createOrderLookups(pendingOrders),
    getPendingCounts, getPendingEntries, getPendingLadderOrders,
    getActiveTpOrderId: () => coreTp.activeTpOrderId,
    isTrackedTpOrder, isBodyTpOrder, getBodyByTpOrderId, removeBodyTracking,
    trackBodyTp, deleteBodyTp, markSettled, handleOrderFill, handleOrderCancel,
  };
};

module.exports = { createExecutorOrderState };
