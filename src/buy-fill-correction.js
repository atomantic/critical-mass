// @ts-check
/** Durable targets for terminal-buy economic corrections (#836).
 * The ledger publishes its journal before these writes. Each target stores
 * the correction ID in the same atomic write as its cost change, so a crash
 * between files resumes without applying a dollar delta twice.
 */
const { roundUSDC } = require('./volatility-utils');
const { syncPositionState } = require('./celestial-hierarchy');

const pendingError = (reason) => Object.assign(new Error(`Buy economic correction pending: ${reason}`), {
  buyCorrectionPending: true,
  syntheticReconciliationRequired: true,
});

/** Plan consumed cost from per-order links, never from global FIFO. */
const planBuyCorrection = (allFills, orderId, costDelta, id) => {
  const orders = new Map();
  for (const fill of allFills) {
    if (fill.side !== 'buy') continue;
    const order = orders.get(fill.orderId) || { size: 0, cost: 0, consumedBy: {}, owned: false, legacy: false };
    order.size += fill.size;
    order.cost += fill.quoteAmount + fill.netFee;
    order.owned ||= Boolean(fill.isBodyOwned || fill.isSatellite || fill.bodyId);
    order.legacy ||= !fill.consumedBy && Number(fill.consumedCostFraction) > 0;
    for (const [sell, qty] of Object.entries(fill.consumedBy || {})) {
      order.consumedBy[sell] = Math.max(order.consumedBy[sell] || 0, qty);
    }
    orders.set(fill.orderId, order);
  }
  const buy = orders.get(orderId);
  if (!(buy?.size > 0)) throw pendingError('buy quantity unavailable');
  if (buy.legacy || buy.consumedBy.__legacy__ > 0) throw pendingError('consumed cost lacks an explicit sell link');
  const consumedQty = Object.values(buy.consumedBy).reduce((sum, qty) => sum + qty, 0);
  if (consumedQty > buy.size + 1e-8) throw pendingError('consumption exceeds buy quantity');
  const sells = [];
  for (const [sellOrderId, qty] of Object.entries(buy.consumedBy)) {
    if (!(qty > 0)) continue;
    const sell = allFills.find(fill => fill.side === 'sell' && fill.orderId === sellOrderId);
    if (!sell || !Number.isFinite(sell.bodyCostBasis) || !Number.isFinite(sell.bodyPnl)) {
      throw pendingError('linked sell has no committed cost annotation');
    }
    // A closing TP's consumedBy includes holdback, while bodyCostBasis is
    // prorated to the actual sold quantity. Preserve that booking's cost
    // share instead of charging the reserve cost to P&L a second time.
    let linkedCost = 0;
    for (const order of orders.values()) {
      linkedCost += order.size > 0 ? order.cost * (order.consumedBy[sellOrderId] || 0) / order.size : 0;
    }
    const fraction = linkedCost > 0 ? sell.bodyCostBasis / linkedCost : NaN;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 + 1e-6) {
      throw pendingError('linked sell cost cannot be reconciled from its buys');
    }
    const bookedSize = Number(sell.bodyBookedSize ?? sell.bodyBtcQty) || 0;
    const capitalCreditFraction = sell.capitalCredited
      ? (Number.isFinite(sell.capitalCreditedSize) && bookedSize > 0
        ? Math.min(1, Math.max(0, sell.capitalCreditedSize / bookedSize)) : 1) : 0;
    sells.push({ sellOrderId, costDelta: costDelta * qty / buy.size * Math.min(1, fraction),
      capitalCreditFraction });
  }
  return { id, orderId, size: buy.size, costDelta, consumedQty, owned: buy.owned, sells, status: 'pending' };
};

/** Pure position projection; the caller publishes before swapping live memory. */
const projectBuyCorrection = (position, correction) => {
  const next = structuredClone(position);
  if (next.appliedBuyCorrections?.includes(correction.id)) return next;
  let openQty = 0;
  for (const body of next.celestialBodies || []) {
    let openDelta = 0;
    // Recompute the tracked part absolutely so successive sub-cent
    // corrections converge instead of rounding each dollar delta again.
    const trackedOpenCost = () => (body.buyOrders || []).reduce((sum, entry) => {
      const qty = Number(entry.assetQty) || 0;
      const consumed = Number.isFinite(entry.consumedQty) ? entry.consumedQty
        : qty * (entry.orderId === correction.orderId
          ? correction.consumedQty / correction.size : (body.consumedCostFraction || 0));
      return sum + (qty > 0 ? (Number(entry.sizeUsdc) || 0) * Math.max(0, qty - consumed) / qty : 0);
    }, 0);
    const before = trackedOpenCost();
    for (const entry of body.buyOrders || []) {
      if (entry.orderId !== correction.orderId) continue;
      const qty = Number(entry.assetQty) || 0;
      const consumed = Number.isFinite(entry.consumedQty) ? entry.consumedQty
        : qty * correction.consumedQty / correction.size;
      const open = Math.max(0, qty - consumed);
      openQty += open;
      const delta = correction.costDelta * qty / correction.size;
      entry.sizeUsdc += delta;
      entry.price = qty > 0 ? entry.sizeUsdc / qty : entry.price;
      openDelta += correction.costDelta * open / correction.size;
    }
    if (Math.abs(openDelta) > 1e-8) {
      body.costBasis = roundUSDC(body.costBasis - roundUSDC(before) + roundUSDC(trackedOpenCost()));
      if (body.costBasis < 0) throw pendingError('corrected body cost would be negative');
      body.avgPrice = body.assetQty > 0 ? body.costBasis / body.assetQty : 0;
      if (body.tpOrderId) body.needsTpReprice = true;
    }
  }
  if (correction.owned && Math.abs(openQty - (correction.size - correction.consumedQty)) > 1e-8) {
    throw pendingError('open buy ownership is not represented by body tranches');
  }
  if (correction.owned) syncPositionState(next, next.celestialBodies || []);
  next.appliedBuyCorrections = [...(next.appliedBuyCorrections || []), correction.id];
  return next;
};

const applyBuyCorrectionCapital = (exchange, pair, correction) => {
  const { getRegimeConfig, updateRegimeConfig } = require('./config-utils');
  const config = getRegimeConfig(exchange, pair);
  if (config.appliedBuyCorrections?.includes(correction.id)) return config.maxUsdcDeployed;
  const delta = correction.sells.reduce((sum, sell) => sum + sell.costDelta * sell.capitalCreditFraction, 0);
  if (Math.abs(delta) <= 1e-8) return config.maxUsdcDeployed;
  const exactCapital = config.maxUsdcDeployed - delta + (config.buyCorrectionCapitalRemainder || 0);
  const maxUsdcDeployed = roundUSDC(exactCapital);
  if (!(maxUsdcDeployed > 0)) throw pendingError('corrected capital would be nonpositive');
  updateRegimeConfig(exchange, pair, { maxUsdcDeployed, buyCorrectionCapitalRemainder: exactCapital - maxUsdcDeployed,
    appliedBuyCorrections: [...(config.appliedBuyCorrections || []), correction.id] });
  return maxUsdcDeployed;
};

/** Used by manual/sync ingestion when there is no live engine ledger. */
const applyPersistedBuyCorrection = (exchange, pair, correction, derived) => {
  const { loadRegimeState, saveRegimeState } = require('./state-tracker');
  const { createClosedTrades } = require('./closed-trades');
  const saved = loadRegimeState(exchange, pair);
  const next = projectBuyCorrection(saved.position, correction);
  next.realizedPnL = derived.realizedPnL;
  next.realizedAssetPnL = derived.realizedAssetPnL;
  next.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
  saveRegimeState(next, saved.regime, exchange, saved.tpOptimizer, saved.sizeOptimizer, pair);
  applyBuyCorrectionCapital(exchange, pair, correction);
  const closed = createClosedTrades(exchange, pair);
  closed.load();
  closed.applyBuyCorrection(correction);
};

module.exports = { planBuyCorrection, projectBuyCorrection, applyBuyCorrectionCapital, applyPersistedBuyCorrection };
