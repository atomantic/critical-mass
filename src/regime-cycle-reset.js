// @ts-check
/**
 * A reset's temporal baseline. requestedCycleId may be null for the first
 * cycle; IDs may be renamed by recalculation without a turnover. Only the
 * generation establishes supersession. baselineTradeIds excludes open-body
 * buys when an owed reset must carry them, and is null until a sweep is needed
 * when no pre-queue baseline was captured. resetCause is not persisted.
 * @typedef {Object} CycleResetContext
 * @property {string|null} requestedCycleId
 * @property {number} baselineTurnoverGeneration
 * @property {Set<string>|null} baselineTradeIds
 * @property {'close'|'operator'} resetCause
 */

/**
 * Public reset result, preserving the engine's existing return shape.
 * turnedOver=true means this invocation established the boundary.
 * turnedOver=false, duplicateClose=true means a prior TP close of the requested
 * cycle already counted it: the caller reverses its pre-persisted close count.
 * duplicateClose=false means supersession without that prior close (e.g. an
 * operator reset); the genuine TP close still earns its optimizer samples.
 * @typedef {{turnedOver: true}|{turnedOver: false, duplicateClose: boolean}} CycleResetResult
 */

/**
 * Used both before cancellation and after its await. The caller supplies the
 * appropriate baseline generation; closes of later cycles cannot duplicate
 * the requested cycle's close. Returns null when this reset may proceed.
 * @param {CycleResetContext} context
 * @param {{turnoverGeneration: number, closeGenerationByCycleId: Map<string|null, number>}} snapshot
 * @returns {CycleResetResult|null}
 */
const classifyResetSupersession = (context, snapshot) => {
  if (context.baselineTurnoverGeneration === snapshot.turnoverGeneration) return null;
  return {
    turnedOver: false,
    duplicateClose: (snapshot.closeGenerationByCycleId.get(context.requestedCycleId) ?? -1)
      > context.baselineTurnoverGeneration,
  };
};

/**
 * Window buys postdate the captured rows. Keep a fully sold buy with its sell;
 * carry unsold buys and buys still owned by an open body, even after a partial
 * sale. A TP merely placed has no recorded sell size and is therefore unsold.
 * Inputs are snapshots; this helper never reads or changes the ledger/bodies.
 * @param {{windowBuys: Array<Object>, soldOrderIds: Set<string>, openBuyOrderIds: Set<string>}} snapshot
 * @returns {Array<Object>}
 */
const selectCarryForwardBuys = ({ windowBuys, soldOrderIds, openBuyOrderIds }) =>
  windowBuys.filter(fill => !soldOrderIds.has(fill.sellOrderId) || openBuyOrderIds.has(fill.orderId));

module.exports = { classifyResetSupersession, selectCarryForwardBuys };
