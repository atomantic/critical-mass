// @ts-check
/** Durable targets for terminal-sell economic corrections (#837).
 * The fill ledger publishes the correction journal and revised sell economics
 * first. Each other store records the correction ID beside its update, so a
 * restart between files resumes without applying a P&L or capital delta twice.
 */
const { roundUSDC } = require('./volatility-utils');

const pendingError = (reason) => Object.assign(new Error(`Sell economic correction pending: ${reason}`), {
  sellCorrectionPending: true,
  syntheticReconciliationRequired: true,
});

const isBooked = (row) => row.bodyBooked === true
  || row.capitalCredited === true
  || (row.bodyBooked == null && (row.bodyPnl != null || row.satellitePnl != null));

/**
 * Plan cross-store deltas from the exact synthetic allocations being replaced.
 * Unbooked coverage stays out of prior P&L, audit, and capital; a later normal
 * booking reads the corrected ledger economics and books that tranche once.
 * @param {Array<Object>} allocations
 * @param {string} id - Real exchange trade ID used as the idempotency key
 * @returns {Object}
 */
const planSellCorrection = (allocations, id) => {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw pendingError('covered sell allocations unavailable');
  }
  const orderId = allocations[0].row?.orderId;
  if (typeof orderId !== 'string' || !orderId
    || allocations.some(allocation => allocation.row?.orderId !== orderId)) {
    throw pendingError('covered sell order identity is inconsistent');
  }

  const totals = {
    quoteDelta: 0,
    netFeeDelta: 0,
    bodyPnlDelta: 0,
    satellitePnlDelta: 0,
    capitalDelta: 0,
    auditProceedsDelta: 0,
    auditFeesDelta: 0,
    auditPnlDelta: 0,
  };
  for (const allocation of allocations) {
    const row = allocation.row;
    const prior = allocation.priorEconomics;
    if (!prior || !Number.isFinite(allocation.quoteAmount) || !Number.isFinite(allocation.netFee)
      || !Number.isFinite(prior.quoteAmount) || !Number.isFinite(prior.netFee)) {
      throw pendingError('covered sell economics are incomplete');
    }
    if (['bodyPnl', 'satellitePnl'].some(field => row[field] != null && !Number.isFinite(Number(row[field])))) {
      throw pendingError('committed sell P&L annotation is invalid');
    }
    const quoteDelta = allocation.quoteAmount - prior.quoteAmount;
    const netFeeDelta = allocation.netFee - prior.netFee;
    const pnlDelta = quoteDelta - netFeeDelta;
    totals.quoteDelta += quoteDelta;
    totals.netFeeDelta += netFeeDelta;

    const booked = isBooked(row);
    if (booked) {
      totals.auditProceedsDelta += pnlDelta;
      totals.auditFeesDelta += netFeeDelta;
      totals.auditPnlDelta += pnlDelta;
      if (row.bodyPnl != null && row.bodyBooked !== false) totals.bodyPnlDelta += pnlDelta;
      if (row.satellitePnl != null && row.bodyBooked !== false) totals.satellitePnlDelta += pnlDelta;
    }
    // claimCapitalCredit stamps only the rows covered by that credit. Keeping
    // this row-level test preserves the existing size watermark: the correction
    // adjusts a prior credit but never claims newly arrived sell quantity.
    if (row.capitalCredited === true) totals.capitalDelta += pnlDelta;
  }

  for (const value of Object.values(totals)) {
    if (!Number.isFinite(value)) throw pendingError('correction delta is not finite');
  }
  return { id, orderId, ...totals, status: 'pending' };
};

const applySellCorrectionCapital = (exchange, pair, correction) => {
  const { getRegimeConfig, updateRegimeConfig } = require('./config-utils');
  const config = getRegimeConfig(exchange, pair);
  if (Math.abs(correction.capitalDelta) <= 1e-12) return config.maxUsdcDeployed;
  const applied = config.appliedSellCorrections || [];
  if (applied.includes(correction.id)) return config.maxUsdcDeployed;

  const exactCapital = config.maxUsdcDeployed + correction.capitalDelta
    + (config.sellCorrectionCapitalRemainder || 0);
  const maxUsdcDeployed = roundUSDC(exactCapital);
  if (!(maxUsdcDeployed > 0)) throw pendingError('corrected capital would be nonpositive');
  updateRegimeConfig(exchange, pair, {
    maxUsdcDeployed,
    sellCorrectionCapitalRemainder: exactCapital - maxUsdcDeployed,
    appliedSellCorrections: [...applied, correction.id],
  });
  return maxUsdcDeployed;
};

/** Persisted fallback used by manual/sync ingestion when no engine is live. */
const applyPersistedSellCorrection = (exchange, pair, correction, derived) => {
  const { loadRegimeState, saveRegimeState } = require('./state-tracker');
  const { createClosedTrades } = require('./closed-trades');
  const saved = loadRegimeState(exchange, pair);
  const next = structuredClone(saved.position || {});
  next.appliedSellCorrections = [...new Set([...(next.appliedSellCorrections || []), correction.id])];
  next.realizedPnL = derived.realizedPnL;
  next.realizedAssetPnL = derived.realizedAssetPnL;
  next.heldAssetCostBasis = derived.heldOpenBuyCostBasis;
  if (next.celestialState) {
    next.celestialState.bodiesRealizedPnL = derived.realizedPnL;
    next.celestialState.bodiesRealizedAssetPnL = derived.realizedAssetPnL;
  }
  saveRegimeState(next, saved.regime, exchange, saved.tpOptimizer, saved.sizeOptimizer, pair);
  applySellCorrectionCapital(exchange, pair, correction);
  const closed = createClosedTrades(exchange, pair);
  closed.load();
  closed.applySellCorrection(correction);
};

module.exports = {
  planSellCorrection,
  applySellCorrectionCapital,
  applyPersistedSellCorrection,
};
