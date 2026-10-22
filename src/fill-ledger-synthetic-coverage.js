// @ts-check
/**
 * Synthetic coverage reconciliation for the fill ledger (issue #1613).
 *
 * A terminal order-status fallback can record a "synthetic" fill standing in
 * for executions the exchange has not reported yet. When the real execution
 * arrives, it is matched against that coverage:
 *
 * - **replace**: the coverage rows carry the same annotations and the real
 *   execution fits inside them, so the real row takes over the covered
 *   quantity (any uncovered remainder stays as a residual synthetic row).
 * - **preserve**: annotations differ, earlier allocations exist, or the real
 *   execution crosses total coverage. The coverage rows keep their quantity
 *   and ownership, the real identity is recorded on them as a
 *   `reconciledTrades` allocation, and only the excess becomes a new tranche.
 *
 * When the real economics differ from the synthetic ones, both modes plan a
 * buy or sell economic correction; the ledger journals it before its
 * accounting targets are updated (`resumeBuyCorrections` /
 * `resumeSellCorrections` in fill-ledger.js apply it).
 *
 * The planners are pure over the ledger's `fills`. The mutators take the
 * ledger's maps and sets through `createSyntheticCoverage(state)`; the dirty
 * flag, persistence and the ledger version stay with the ledger.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');
const { planBuyCorrection } = require('./buy-fill-correction');
const { planSellCorrection } = require('./sell-fill-correction');
const { isBodyOwnedFill } = require('../shared/cycle-pairing.mjs');
const { ORDER_LEVEL_FIELDS } = require('./fill-ledger-recalc');

/**
 * @typedef {import('./types').Fill} Fill
 * @typedef {Object} CoverageState
 * @property {Map<string, Fill>} fills - tradeId -> fill
 * @property {Map<string, Set<string>>} cycleIndex - cycleId -> tradeIds
 * @property {Map<string, number>} orderSizeIndex - orderId -> recorded size
 * @property {Set<string>} syntheticOrders - orderIds with unresolved coverage
 * @property {Set<string>} reconciledTradeIds - real tradeIds recorded only on coverage rows
 */

const ECONOMIC_FIELDS = ['quoteAmount', 'fee', 'netFee', 'rebate'];

const equivalent = (a, b) => Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= 1e-8;

const sumEconomics = (parts) => {
  const totals = { quoteAmount: 0, fee: 0, netFee: 0, rebate: 0 };
  for (const part of parts) {
    for (const key of ECONOMIC_FIELDS) totals[key] += part[key];
  }
  return totals;
};

const prorateEconomics = (economics, ratio) => {
  const prorated = {};
  for (const key of ECONOMIC_FIELDS) prorated[key] = economics[key] * ratio;
  return prorated;
};

const economicCorrectionFields = ({ buyCorrection, sellCorrection }) => ({
  ...(buyCorrection && { buyEconomicCorrection: buyCorrection }),
  ...(sellCorrection && { sellEconomicCorrection: sellCorrection }),
});

// Only terminal order-status fallbacks own exchange execution coverage.
// Recognize the old exact ID shapes too, so existing ledgers can converge.
const isSyntheticCoverage = (fill) => fill.syntheticCoverage != null
  || fill.tradeId === `synthetic-${fill.orderId}`
  || (typeof fill.tradeId === 'string' && fill.tradeId.startsWith(`synthetic-${fill.orderId}-`)
    && Number.isFinite(Number(fill.tradeId.slice(`synthetic-${fill.orderId}-`.length))));

const reconciledCoverageSize = (fill) => (fill.syntheticCoverage?.reconciledTrades || [])
  .reduce((sum, allocation) => sum + (Number(allocation.size) || 0), 0);

const unresolvedSyntheticSize = (fill) =>
  Math.max(0, (Number(fill.size) || 0) - reconciledCoverageSize(fill));

const isUnresolvedSyntheticCoverage = (fill) =>
  isSyntheticCoverage(fill) && unresolvedSyntheticSize(fill) > 1e-9;

/**
 * @param {Map<string, Fill>} fills
 */
const planCorrectionIfEconomicsDiffer = (fills, fill, covered, executionTotals, allocations) => {
  let buyCorrection;
  let sellCorrection;
  if (!ECONOMIC_FIELDS.every(key => equivalent(executionTotals[key], covered[key]))) {
    if (fill.side === 'buy') {
      buyCorrection = planBuyCorrection(Array.from(fills.values()), fill.orderId,
        executionTotals.quoteAmount + executionTotals.netFee - covered.quoteAmount - covered.netFee, fill.tradeId);
    } else {
      sellCorrection = planSellCorrection(allocations, fill.tradeId);
    }
  }
  return { buyCorrection, sellCorrection };
};

/**
 * @param {Map<string, Fill>} fills
 */
const planPreservedCoverage = (fills, fill, covered, coveredSize) => {
  let remaining = coveredSize;
  const allocations = [];
  const reported = {
    size: fill.size,
    price: fill.price,
    quoteAmount: fill.quoteAmount,
    fee: fill.fee,
    netFee: fill.netFee,
    rebate: fill.rebate,
  };
  for (const row of covered) {
    if (remaining <= 1e-9) break;
    const quantity = Math.min(remaining, unresolvedSyntheticSize(row));
    if (quantity <= 1e-9) continue;
    const original = row.syntheticCoverage?.originalEconomics || row;
    allocations.push({
      row,
      tradeId: row.tradeId,
      size: quantity,
      ...prorateEconomics(reported, quantity / reported.size),
      priorEconomics: prorateEconomics({ ...original, rebate: original.rebate || 0 }, quantity / row.size),
    });
    remaining = roundAsset(Math.max(0, remaining - quantity));
  }
  const syntheticTotals = sumEconomics(allocations.map(allocation => allocation.priorEconomics));
  const executionTotals = sumEconomics(allocations);
  const corrections = planCorrectionIfEconomicsDiffer(fills, fill, syntheticTotals, executionTotals, allocations);
  const newSize = roundAsset(Math.max(0, reported.size - coveredSize));
  const newQuote = Math.max(0, reported.quoteAmount - executionTotals.quoteAmount);
  const newFee = Math.max(0, reported.fee - executionTotals.fee);
  const newNetFee = reported.netFee - executionTotals.netFee;
  const newRebate = reported.rebate - executionTotals.rebate;
  const ledgerExecution = {
    ...fill,
    ...economicCorrectionFields(corrections),
    reportedExecution: reported,
    syntheticCoverageReconciliation: {
      coveredSize,
      newSize,
      coveredQuoteAmount: executionTotals.quoteAmount,
      newQuoteAmount: newQuote,
      coveredFee: executionTotals.fee,
      newFee,
      coveredNetFee: executionTotals.netFee,
      newNetFee,
      coveredRebate: executionTotals.rebate,
      newRebate,
      allocations: allocations.map(({ tradeId, size, quoteAmount, fee, netFee, rebate }) => ({
        tradeId, size, quoteAmount, fee, netFee, rebate,
      })),
    },
    replacesSyntheticTradeIds: [...new Set(allocations.map(allocation => allocation.tradeId))],
    size: newSize > 1e-9 ? newSize : 0,
    quoteAmount: newSize > 1e-9 ? newQuote : 0,
    fee: newSize > 1e-9 ? newFee : 0,
    netFee: newSize > 1e-9 ? newNetFee : 0,
    rebate: newSize > 1e-9 ? newRebate : 0,
    ...(newSize > 1e-9 ? { price: newQuote / newSize } : {}),
  };
  return { mode: 'preserve', ledgerExecution, reportedExecution: fill,
    annotations: {}, allocations, replacements: [],
    corrections: { buy: corrections.buyCorrection, sell: corrections.sellCorrection }, coveredSize, newSize };
};

/**
 * @param {Map<string, Fill>} fills
 */
const planReplacedCoverage = (fills, fill, covered, annotations) => {
  let remaining = fill.size;
  const replacements = [];
  const allocations = [];
  for (const row of covered) {
    if (remaining <= 1e-9) break;
    const quantity = Math.min(remaining, unresolvedSyntheticSize(row));
    const ratio = quantity / row.size;
    const economics = { ...row, rebate: row.rebate || 0 };
    allocations.push({
      row,
      tradeId: row.tradeId,
      size: quantity,
      ...prorateEconomics(fill, quantity / fill.size),
      priorEconomics: prorateEconomics(economics, ratio),
    });
    const residualSize = roundAsset(row.size - quantity);
    replacements.push({ old: row, residual: residualSize > 1e-9 ? {
      ...row,
      size: residualSize,
      ...prorateEconomics(economics, 1 - ratio),
    } : null });
    remaining = roundAsset(remaining - quantity);
  }
  const syntheticTotals = sumEconomics(allocations.map(allocation => allocation.priorEconomics));
  const corrections = planCorrectionIfEconomicsDiffer(fills, fill, syntheticTotals, fill, allocations);
  const inheritedAnnotations = {};
  const anchor = covered[0];
  for (const key of annotations) {
    if (anchor[key] !== undefined) inheritedAnnotations[key] = key === 'consumedBy'
      ? { ...anchor[key] } : anchor[key];
  }
  // Real rows retain the replaced identities for diagnostics, never as coverage for another real ID.
  const ledgerExecution = { ...fill,
    ...economicCorrectionFields(corrections),
    ...inheritedAnnotations,
    replacesSyntheticTradeIds: replacements.map(item => item.old.tradeId),
  };
  return { mode: 'replace', ledgerExecution, reportedExecution: fill,
    annotations: inheritedAnnotations, allocations: [], replacements,
    corrections: { buy: corrections.buyCorrection, sell: corrections.sellCorrection }, coveredSize: fill.size, newSize: 0 };
};

const coverageRequiresPreservation = (fill, covered, total, annotations) => {
  const anchor = covered[0];
  const sameAnnotations = covered.every(row => annotations.every(key =>
    JSON.stringify(row[key]) === JSON.stringify(anchor[key])));
  const hasPriorAllocations = covered.some(row =>
    (row.syntheticCoverage?.reconciledTrades || []).length > 0);
  return fill.size > total + 1e-9 || !sameAnnotations || hasPriorAllocations;
};

/**
 * Plan how a real execution reconciles against its order's unresolved
 * synthetic coverage, or null when there is none. Pure: reads `fills` and
 * `syntheticOrders`, mutates neither (nor the execution).
 *
 * Equivalent coverage with matching annotations can be replaced directly. Keep
 * quantity/ownership rows when executions cross coverage or annotations differ;
 * only excess quantity becomes a new tranche. Both plans publish correction
 * journals before their accounting targets are updated.
 * @param {Fill} fill - the normalized real execution
 * @param {{fills: Map<string, Fill>, syntheticOrders: Set<string>}} state
 */
const reconcileSyntheticCoverage = (fill, { fills, syntheticOrders }) => {
  if (isSyntheticCoverage(fill) || !syntheticOrders.has(fill.orderId)) return null;
  const covered = Array.from(fills.values())
    .filter(row => row.orderId === fill.orderId && row.side === fill.side && isUnresolvedSyntheticCoverage(row))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!covered.length) return null;
  const total = covered.reduce((sum, row) => sum + unresolvedSyntheticSize(row), 0);
  if (!Number.isFinite(fill.size) || fill.size <= 0) {
    throw Object.assign(new Error(`Synthetic execution reconciliation required for order ${fill.orderId}: real execution has an invalid quantity`), {
      syntheticReconciliationRequired: true,
    });
  }
  const annotations = [...(ORDER_LEVEL_FIELDS[fill.side] || []),
    'cycleId', 'bodyBooked', 'capitalCredited', 'capitalCreditedSize'];
  const preserveCoverage = coverageRequiresPreservation(fill, covered, total, annotations);
  return preserveCoverage
    ? planPreservedCoverage(fills, fill, covered, Math.min(fill.size, total))
    : planReplacedCoverage(fills, fill, covered, annotations);
};

/**
 * The fills the caller still has to book after an ingest: the execution
 * itself when there was no reconciliation, nothing for a replacement (the
 * replaced coverage was already accounted), and for preservation the covered
 * allocations whose rows are not yet accounted plus any excess tranche.
 */
const getBookableReconciliationFills = (fill, reconciliation) => {
  let bookableFills = [fill];
  if (reconciliation?.mode === 'replace') {
    bookableFills = [];
  } else if (reconciliation?.mode === 'preserve') {
    bookableFills = [];
    for (const allocation of reconciliation.allocations) {
      const coveredFill = allocation.row;
      const alreadyAccounted = fill.side === 'buy'
        ? isBodyOwnedFill(coveredFill)
        : Boolean(coveredFill.bodyBooked || (coveredFill.bodyBooked == null && coveredFill.bodyPnl != null));
      if (!alreadyAccounted) {
        bookableFills.push({
          ...coveredFill,
          size: allocation.size,
          quoteAmount: allocation.quoteAmount,
          fee: allocation.fee,
          netFee: allocation.netFee,
          rebate: allocation.rebate,
          price: allocation.size > 0 ? allocation.quoteAmount / allocation.size : coveredFill.price,
          syntheticCoverageAllocation: true,
        });
      }
    }
    if (fill.size > 1e-9) bookableFills.push(fill);
  }
  return bookableFills;
};

/**
 * Bind the coverage mutators to the ledger's in-memory state. Every
 * collection is mutated in place; none is ever reassigned by the ledger.
 * @param {CoverageState} state
 */
const createSyntheticCoverage = (state) => {
  const { fills, cycleIndex, orderSizeIndex, syntheticOrders, reconciledTradeIds } = state;

  const recordPreservedCoverage = (fill, reconciliation, tradeId) => {
    for (const allocation of reconciliation.allocations) {
      const prior = allocation.row.syntheticCoverage || {};
      if (reconciliation.corrections.buy || reconciliation.corrections.sell) {
        const originalEconomics = prior.originalEconomics || {
          quoteAmount: allocation.row.quoteAmount, fee: allocation.row.fee,
          netFee: allocation.row.netFee, rebate: allocation.row.rebate || 0,
        };
        prior.originalEconomics = originalEconomics;
        for (const key of ['quoteAmount', 'fee', 'netFee', 'rebate']) {
          allocation.row[key] += allocation[key] - allocation.priorEconomics[key];
        }
        allocation.row.price = allocation.row.quoteAmount / allocation.row.size;
      }
      const reconciledTrades = Array.isArray(prior.reconciledTrades)
        ? prior.reconciledTrades : [];
      allocation.row.syntheticCoverage = {
        ...prior,
        reconciledTrades: [...reconciledTrades, {
          tradeId,
          size: allocation.size,
          quoteAmount: allocation.quoteAmount,
          fee: allocation.fee,
          netFee: allocation.netFee,
          rebate: allocation.rebate,
        }],
      };
      fills.set(allocation.row.tradeId, allocation.row);
    }
    reconciledTradeIds.add(tradeId);
  };

  const journalBuyEconomicCorrection = (fill, reconciliation) => {
    const correction = fill.buyEconomicCorrection;
    // Identity-only preserve mode has no real quantity row; its journal
    // belongs to the coverage row that durably records the real identity.
    const journalRow = fill.size > 1e-9 ? fill : reconciliation.allocations[0].row;
    journalRow.buyEconomicCorrections = [...(journalRow.buyEconomicCorrections || []), correction];
    for (const sell of correction.sells) {
      for (const row of fills.values()) {
        if (row.side !== 'sell' || row.orderId !== sell.sellOrderId) continue;
        row.bodyCostBasis += sell.costDelta;
        row.bodyPnl -= sell.costDelta;
        if (row.bodyBtcQty > 0) row.bodyAvgPrice = row.bodyCostBasis / row.bodyBtcQty;
      }
    }
    delete fill.buyEconomicCorrection;
  };

  const journalSellEconomicCorrection = (fill, reconciliation) => {
    const correction = fill.sellEconomicCorrection;
    // Identity-only preserve mode has no real quantity row; its journal
    // belongs to the synthetic row that durably records the real identity.
    const journalRow = fill.size > 1e-9 ? fill : reconciliation.allocations[0].row;
    journalRow.sellEconomicCorrections = [...(journalRow.sellEconomicCorrections || []), correction];
    const applyPnlDelta = (field, delta) => {
      if (Math.abs(delta) <= 1e-12) return;
      for (const row of fills.values()) {
        if (row.side !== 'sell' || row.orderId !== correction.orderId || row[field] == null) continue;
        const exact = Number(row[field]) + delta + Number(row.sellCorrectionPnlRemainder || 0);
        row[field] = roundUSDC(exact);
        row.sellCorrectionPnlRemainder = exact - row[field];
      }
    };
    // These are order-level annotations: update each copy by the portion
    // that was already booked, while leaving quantities, cost, holdback,
    // consumption, and the capital-credit watermark untouched.
    applyPnlDelta('bodyPnl', correction.bodyPnlDelta);
    applyPnlDelta('satellitePnl', correction.satellitePnlDelta);
    delete fill.sellEconomicCorrection;
  };

  /** Snapshot the state a reconciliation touches (null when there is none).
   * The ledger adds its own dirty flag. */
  const captureIngestRollback = (fill, tradeId, reconciliation) => {
    if (!reconciliation) return null;
    return {
      fills: new Map(Array.from(fills, ([id, row]) => [id, structuredClone(row)])),
      cycleIndex: new Map(Array.from(cycleIndex, ([id, ids]) => [id, new Set(ids)])),
      orderSize: orderSizeIndex.get(fill.orderId),
      hadSyntheticCoverage: syntheticOrders.has(fill.orderId),
      hadReconciledTrade: reconciledTradeIds.has(tradeId),
    };
  };

  const restoreIngestRollback = (snapshot, fill, tradeId) => {
    fills.clear();
    for (const [id, row] of snapshot.fills) fills.set(id, row);
    cycleIndex.clear();
    for (const [id, ids] of snapshot.cycleIndex) cycleIndex.set(id, ids);
    if (snapshot.orderSize === undefined) orderSizeIndex.delete(fill.orderId);
    else orderSizeIndex.set(fill.orderId, snapshot.orderSize);
    if (snapshot.hadSyntheticCoverage) syntheticOrders.add(fill.orderId);
    else syntheticOrders.delete(fill.orderId);
    if (snapshot.hadReconciledTrade) reconciledTradeIds.add(tradeId);
    else reconciledTradeIds.delete(tradeId);
  };

  const applyCoverageReplacements = (replacements) => {
    for (const { old, residual } of replacements) {
      if (residual) fills.set(old.tradeId, residual);
      else {
        fills.delete(old.tradeId);
        if (old.cycleId) cycleIndex.get(old.cycleId)?.delete(old.tradeId);
      }
    }
  };

  /** Keep `syntheticOrders` to the orders that still have unresolved coverage. */
  const refreshSyntheticOrder = (row, reconciliation) => {
    if (isUnresolvedSyntheticCoverage(row)) syntheticOrders.add(row.orderId);
    else if (reconciliation && !Array.from(fills.values()).some(stored =>
      stored.orderId === row.orderId && isUnresolvedSyntheticCoverage(stored))) syntheticOrders.delete(row.orderId);
  };

  const indexIngestedFill = (fill, tradeId, replacements) => {
    if (fill.cycleId && fill.size > 1e-9) {
      if (!cycleIndex.has(fill.cycleId)) cycleIndex.set(fill.cycleId, new Set());
      cycleIndex.get(fill.cycleId).add(tradeId);
    }
    // Maintain per-order size index for O(1) watermark lookups in retry loops.
    // Round to asset precision so accumulated float error can't keep the
    // retry chain running on a fully-recorded order (see load() for context).
    if (fill.orderId) {
      const replacedSize = replacements.reduce((sum, item) => sum + item.old.size - (item.residual?.size || 0), 0);
      const next = (orderSizeIndex.get(fill.orderId) || 0) + (fill.size || 0) - replacedSize;
      orderSizeIndex.set(fill.orderId, roundAsset(next));
    }
  };

  return {
    reconcile: (fill) => reconcileSyntheticCoverage(fill, state),
    recordPreservedCoverage,
    journalBuyEconomicCorrection,
    journalSellEconomicCorrection,
    captureIngestRollback,
    restoreIngestRollback,
    applyCoverageReplacements,
    refreshSyntheticOrder,
    indexIngestedFill,
  };
};

module.exports = {
  isSyntheticCoverage,
  unresolvedSyntheticSize,
  isUnresolvedSyntheticCoverage,
  reconcileSyntheticCoverage,
  getBookableReconciliationFills,
  createSyntheticCoverage,
};
