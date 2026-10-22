/**
 * Pure helpers for the regime engine.
 *
 * Extracted verbatim from regime-engine.js (issue #1596). None of these touch
 * I/O or engine closure state: they take their inputs as arguments and return
 * a value (a few mutate only the body/marker arrays they are handed, as
 * documented on each). No accounting changes — code move only.
 */

const { roundAsset, roundUSDC } = require('./volatility-utils');
const { floorToIncrement } = require('./shared-utils');

/**
 * Shape an adapter `getOrder` result into the `fillData` payload that
 * `handleOrderFill` consumes. Centralizes parseFloat coercion of numeric
 * fields so every catch-up site treats missing/string values identically.
 * Defaults `isPartialFill: true` since every caller in this file uses it
 * for catch-up routes; pass `{ isPartialFill: false }` (or `placedAt`,
 * `status`) via extras to override.
 * @param {string} orderId
 * @param {'buy'|'sell'} side
 * @param {{status: string, filledSize?: number|string, filledValue?: number|string, averageFilledPrice?: number|string}} orderStatus
 * @param {Object} [extras] Field overrides merged onto the result
 * @returns {Object} fillData for handleOrderFill
 */
const buildPartialFillData = (orderId, side, orderStatus, extras = {}) => ({
  orderId,
  side,
  status: orderStatus.status,
  filledSize: parseFloat(orderStatus.filledSize || 0),
  // Preserve absence so terminal fallback can derive cumulative quote from
  // the average and the resolved quantity (including a saved high-water mark).
  // Explicit zero or malformed quote remains present and fails validation.
  filledValue: orderStatus.filledValue == null ? undefined : parseFloat(orderStatus.filledValue),
  averageFilledPrice: parseFloat(orderStatus.averageFilledPrice || 0),
  isPartialFill: true,
  ...extras,
});

/**
 * Build the shared in-memory dedup key used by WS and polling fill callbacks.
 * Partial fills are keyed by cumulative size so each advance is processed once;
 * terminal fills remain keyed by order ID.
 * @param {string} orderId
 * @param {boolean} isPartialFill
 * @param {number} [filledSize]
 * @returns {string}
 */
const makeFillDedupKey = (orderId, isPartialFill, filledSize = 0) =>
  isPartialFill ? `${orderId}:${(filledSize || 0).toFixed(8)}` : orderId;

/**
 * Decide how much USDC an entry can actually spend, given the requested size,
 * the real available wallet balance, and the minimum order size.
 *
 * The risk-manager usdc-cap check only compares deployed cost basis against
 * maxUsdcDeployed — it does NOT know the real wallet balance. Without this,
 * a cap set far above funded capital makes the engine keep firing entries the
 * exchange rejects with "Insufficient balance in source account" every cycle.
 *
 * Pure function (no I/O) so the trim/skip/cooldown branches are unit-testable.
 *
 * @param {number} requestedUsdc - Desired order size in USDC
 * @param {number|null} availableQuote - Real available quote balance, or null if it couldn't be fetched
 * @param {number} minSize - Minimum order size in USDC
 * @returns {{action: 'place'|'skip'|'cooldown', sizeUsdc?: number}}
 *   - 'place': proceed with sizeUsdc (possibly trimmed to the wallet balance)
 *   - 'skip': balance unverifiable — skip this entry without arming the cooldown
 *   - 'cooldown': wallet can't fund even the minimum — arm the insufficient-funds cooldown
 */
const resolveEntryBudget = (requestedUsdc, availableQuote, minSize) => {
  if (availableQuote == null) return { action: 'skip' };
  if (availableQuote >= requestedUsdc) return { action: 'place', sizeUsdc: requestedUsdc };
  if (availableQuote >= minSize) {
    // Floor (don't round) to the cent so the trimmed size never exceeds the real
    // balance — Math.round could push it back above the wallet and re-trigger the
    // very rejection this trim prevents.
    return { action: 'place', sizeUsdc: Math.floor(availableQuote * 100) / 100 };
  }
  return { action: 'cooldown' };
};

/**
 * True when an exchange error/result message reports insufficient funds.
 * @param {unknown} msg
 * @returns {boolean}
 */
const isInsufficientFundsMessage = (msg) => {
  if (typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  return (
    m.includes('insufficientfunds') ||
    m.includes('insufficient_available_balance') ||
    m.includes('insufficient_fund') || // Coinbase enum: INSUFFICIENT_FUND / PREVIEW_INSUFFICIENT_FUND
    m.includes('insufficient balance') || // Coinbase human msg: "Insufficient balance in source account"
    m.includes('insufficient fund')
  );
};

/**
 * Final entry size after the macro multiplier: if the remaining budget can't fit
 * 2 orders at minimum, spend it all in one last order (only when it is at least
 * the minimum); otherwise floor at the minimum. Zero-size regimes stay zero.
 * @param {{ sizing: { sizeUsdc: number }, macroMult: { sizeMult: number }, minSize: number, remainingBudget: number }} args
 * @returns {number}
 */
const sizeEntry = ({ sizing, macroMult, minSize, remainingBudget }) => {
  const sizeUsdc = roundUSDC(sizing.sizeUsdc * macroMult.sizeMult);
  if (sizeUsdc <= 0) return sizeUsdc;
  if (remainingBudget >= minSize && remainingBudget < minSize * 2) return remainingBudget;
  return Math.max(sizeUsdc, minSize);
};

const ENTRY_OFFSET_KEY_BY_MOMENTUM = { up: 'entryOffsetUpBps', down: 'entryOffsetDownBps' };

/**
 * Entry offset in bps for the current momentum, scaled by the macro offset multiplier.
 * UP momentum: smaller offset to get fills before price rises further.
 * DOWN momentum: larger offset to catch the falling price.
 * NEUTRAL: the default config offset.
 * @param {string} momentumDirection
 * @param {Record<string, number>} config
 * @param {{ offsetMult: number }} macroMult
 * @returns {number}
 */
const entryOffsetBps = (momentumDirection, config, macroMult) =>
  Math.round(config[ENTRY_OFFSET_KEY_BY_MOMENTUM[momentumDirection] || 'entryOffsetBps'] * macroMult.offsetMult);

/**
 * True when some celestial body already lists `orderId` among its constituent
 * buy orders — i.e. a prior handleOrderFill attempt already committed this buy
 * (issue #131). Used to make the buy-fill branch idempotent against a retry
 * that re-enters after the dedup key was cleared on a post-commit throw.
 * @param {Array<{sourceOrderIds?: string[], buyOrders?: Array<{orderId: string}>}>} bodies
 * @param {string} orderId
 * @returns {boolean}
 */
const isBuyAlreadyCommitted = (bodies, orderId) =>
  (bodies || []).some(b =>
    (b.sourceOrderIds || []).includes(orderId) ||
    (b.buyOrders || []).some(bo => bo.orderId === orderId)
  );

/**
 * A buy fill row that no body ever booked: it carries none of the order-level
 * annotations a body writes. Only meaningful for an order no live body owns —
 * annotation repair and TP placement stamp EVERY row of an owned order, so a
 * booked-looking row of an owned order can still be unbooked (issue #756).
 * @param {Object} f - Fill ledger row
 * @returns {boolean}
 */
const isUnsettledBuyRow = (f) => f.side === 'buy' && !(f.bodyId || f.isBodyOwned || f.isSatellite || f.sellOrderId);

/**
 * The rows one buy-booking pass commits to a body (issue #1021): every
 * still-unbooked ledger row of the order — including a row an earlier,
 * failed attempt ingested but never booked — plus this pass's bookable rows
 * (new executions, and synthetic-coverage allocations), each identity once.
 * An allocation shares its covered row's tradeId; when the ledger still
 * reports that row unbooked, the whole row is the outstanding quantity.
 * Rows a body already booked are excluded, so a replay stays idempotent.
 * @param {Array<Object>} ledgerRows - fillLedger.getFillsForOrder(orderId)
 * @param {Array<Object>} ingestedRows - This pass's bookable rows
 * @returns {Array<Object>}
 */
const collectBuyBookingBatch = (ledgerRows, ingestedRows) => {
  const batch = (ledgerRows || []).filter(isUnsettledBuyRow);
  const seen = new Set(batch.map(f => f.tradeId));
  for (const f of (ingestedRows || [])) {
    if (seen.has(f.tradeId)) continue;
    seen.add(f.tradeId);
    batch.push(f);
  }
  return batch;
};

/**
 * How much of a buy order the live bodies' tranches fail to account for
 * (issue #756). A body records every tranche it books from an order as a
 * `buyOrders` entry, and a sale never shrinks that entry (it advances its
 * `consumedQty`), so the order's ledger size should equal what live tranches
 * hold plus what bodies that are gone consumed. The latter is only known
 * from #607 consumption records: the part of `ledger.consumedQty` live
 * tranches do not explain. Anything left over is ledger quantity no body
 * represents.
 *
 * Before #607 a sold-and-closed body left no such record, so for an order
 * split across a closed body and a live one this over-reads the shortfall —
 * callers must bound it with independent evidence before booking anything.
 * @param {Array<Object>} bodies - positionState.celestialBodies
 * @param {string} orderId - Buy order id
 * @param {{size: number, consumedQty?: number, consumedCostFraction?: number}} ledger - fillLedger.getBuyOrderConsumption(orderId)
 * @returns {{owned: boolean, measurable: boolean, trancheQty: number, trancheCost: number, shortfall: number}}
 *   `measurable` is false when a body references the order through something
 *   without a quantity (a tranche with no assetQty, or a sourceOrderId with
 *   no tranche) — its share is then unknown.
 */
const measureUnbookedOrderQty = (bodies, orderId, ledger) => {
  const legacyFraction = Math.min(Math.max(Number(ledger?.consumedCostFraction) || 0, 0), 1);
  let owned = false;
  let measurable = true;
  let trancheQty = 0;
  let trancheCost = 0;
  let trancheConsumed = 0;
  const seen = new Set();
  for (const body of (bodies || [])) {
    let measured = false;
    for (const entry of (body.buyOrders || [])) {
      if (!entry || entry.orderId !== orderId || seen.has(entry)) continue;
      seen.add(entry);
      owned = true;
      const size = Number(entry.assetQty) || 0;
      if (!(size > 0)) { measurable = false; continue; }
      measured = true;
      trancheQty += size;
      trancheCost += Number(entry.sizeUsdc) || 0;
      trancheConsumed += Number.isFinite(entry.consumedQty)
        ? Math.min(Math.max(entry.consumedQty, 0), size)
        : size * legacyFraction;
    }
    if ((body.sourceOrderIds || []).includes(orderId)) {
      owned = true;
      if (!measured) measurable = false;
    }
  }
  const consumedElsewhere = Math.max(0, (Number(ledger?.consumedQty) || 0) - trancheConsumed);
  const shortfall = (Number(ledger?.size) || 0) - trancheQty - consumedElsewhere;
  return { owned, measurable, trancheQty, trancheCost, shortfall };
};

/**
 * Bound the earlier, still-unbooked rows an advancing buy pass recovers
 * alongside its new executions (issue #1021) by the bodies' own accounting.
 * For an order a live body already owns, an unannotated row is only proof
 * of a missing tranche when the order's ledger size minus what live
 * tranches hold and what gone bodies consumed (measureUnbookedOrderQty)
 * covers the whole batch. Otherwise — or when the owner's share cannot be
 * measured — the pass books only this pass's own rows, as before, and the
 * withheld rows are left for an operator or the startup recovery (#756).
 * An order no live body owns has no tranche to double-count against.
 * @param {Array<Object>} batch - collectBuyBookingBatch result
 * @param {Array<Object>} ingestedRows - This pass's bookable rows
 * @param {Array<Object>} bodies - positionState.celestialBodies
 * @param {string} orderId - Buy order id
 * @param {Object|null} consumption - fillLedger.getBuyOrderConsumption(orderId)
 * @returns {{batch: Array<Object>, withheldQty: number, shortfall?: number}}
 */
const boundRecoveredBuyRows = (batch, ingestedRows, bodies, orderId, consumption) => {
  const ingestedIds = new Set((ingestedRows || []).map(f => f.tradeId));
  const recovered = batch.filter(f => !ingestedIds.has(f.tradeId));
  if (recovered.length === 0 || ingestedIds.size === 0) return { batch, withheldQty: 0 };
  const measure = measureUnbookedOrderQty(bodies, orderId, consumption);
  if (!measure.owned) return { batch, withheldQty: 0 };
  const qty = rows => rows.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  if (measure.measurable && qty(batch) <= measure.shortfall + 1e-8) return { batch, withheldQty: 0 };
  return {
    batch: batch.filter(f => ingestedIds.has(f.tradeId)),
    withheldQty: roundAsset(qty(recovered)),
    shortfall: measure.measurable ? roundAsset(measure.shortfall) : undefined,
  };
};

/**
 * Pure predicate: did a body TP execute its whole PLANNED size? A TP is placed
 * for `body.assetOnOrder` (body.assetQty minus the designed holdback), so a
 * fill that covers ≥99% of it is a completed TP — its body closes and the
 * holdback is booked as reserves — even when the order was later reported
 * CANCELLED (the cancel-after-full-fill race). Mirrors the sell handler's own
 * isPartial check, including its legacy fallback for bodies with no recorded
 * assetOnOrder (issues #670, #744).
 * @param {{assetOnOrder?: number, assetQty?: number}|null|undefined} body
 * @param {number} filledSize - Cumulative size the TP executed
 * @returns {boolean}
 */
const isFullTpExecution = (body, filledSize) => {
  if (!body || !(filledSize > 0)) return false;
  const onOrder = body.assetOnOrder || 0;
  return onOrder > 0
    ? filledSize >= onOrder * 0.99
    : body.assetQty > 0 && filledSize / body.assetQty >= 0.95;
};

/**
 * Split a body TP's net holdback (`body.assetQty − sold`) into what the sale
 * adds to reserves and what it draws out of them (issue #770).
 *
 * A healthy TP sells `assetOnOrder < assetQty`, and the rest is booked as
 * zero-cost reserves. A stale TP sized for a larger, pre-deduction body can
 * sell MORE than the body still holds (the #744 merge-snapshot oversell). The
 * extra asset came out of the account's reserves: bodyPnl already charges the
 * whole remaining body cost against the full proceeds, so that asset's
 * proceeds are in realized USD at zero cost, and reserves must shrink by the
 * same quantity or it counts twice (as USD and as reserves still held).
 *
 * The drawdown is recorded as its own non-negative quantity rather than as a
 * negative holdback: the cycle pairing clamps negative holdback annotations
 * (legacy corrupt rows), and the startup annotation repair re-pairs any sell
 * carrying one. `bodyReservesSoldAsset` is subtracted from realizedAssetPnL
 * by shared/cycle-pairing.mjs.
 * @param {number} netHoldback - body.assetQty − sold qty, already rounded
 * @returns {{holdbackAsset: number, reservesSoldAsset: number}} both ≥ 0
 */
const splitTpHoldback = (netHoldback) => ({
  holdbackAsset: netHoldback > 0 ? netHoldback : 0,
  reservesSoldAsset: netHoldback < 0 ? -netHoldback : 0,
});

/**
 * Drop a persisted `pendingTpCancelExecution` marker once the body's TP has
 * moved off the order it was recorded for (issue #744). The marker is only
 * ever honoured while `body.tpOrderId === marker.orderId` (see
 * knownTpCancelExecution), and order ids are never reused, so after the TP
 * moves (booked through a plain status branch, re-placed, cleared) it is dead
 * state that would otherwise ride along in every save forever.
 * @param {Array<Object>|null|undefined} bodies
 * @returns {number} How many markers were dropped
 */
const pruneStaleTpCancelMarkers = (bodies) => {
  let pruned = 0;
  for (const body of bodies || []) {
    const marker = body && body.pendingTpCancelExecution;
    if (marker && marker.orderId !== body.tpOrderId) {
      delete body.pendingTpCancelExecution;
      pruned += 1;
    }
  }
  return pruned;
};

/**
 * Pure predicate: is this body stranded sub-min "dust"? — it has a positive qty,
 * no resting TP order, AND its entire qty rounds below the exchange minimum order
 * size, so a TP can never be placed for it on its own. Such a body must be
 * consolidated into another body to recover its value (issue #189).
 *
 * The `assetQty > 0` guard excludes empty/zero bodies (a zero body isn't value to
 * recover and must not trigger a merge that churns a healthy neighbour's TP); a
 * tiny-but-positive qty that rounds to 0 IS dust and should be consolidated.
 * @param {Object} body - Celestial body
 * @param {number} baseMinSize - Exchange minimum order size (base asset)
 * @param {number} baseIncrement - Exchange base-size increment for rounding
 * @param {{effectiveMaxTpPct: number, feeRate: number}|null} [economics] - When given, also flags bodies that can never clear the $0.01 profit floor
 * @returns {boolean}
 */
const isStrandedDustBody = (body, baseMinSize, baseIncrement, economics = null) => {
  if (!body || body.tpOrderId || !(body.assetQty > 0)) return false;
  // Economic dust: sellable by size, but even selling everything at the maximum
  // TP cannot net the $0.01 floor placeBodyTp enforces, so no TP is ever placed.
  // Best case ignores holdback (strictly more proceeds), so this only fires when
  // no TP could ever be placed; a body that could still clear the floor is left
  // alone. Needs a real cost basis — a missing/zero one can't be judged.
  if (economics && body.costBasis > 0) {
    const { effectiveMaxTpPct, feeRate } = economics;
    const bestCasePnl = body.costBasis * ((1 + effectiveMaxTpPct / 100) * (1 - feeRate) - 1);
    if (bestCasePnl < 0.01) return true;
  }
  const inc = baseIncrement || 0.00000001;
  // floorToIncrement (epsilon-safe), NOT a naive Math.floor(qty/inc)*inc: for a
  // decimal increment like 0.01, float error under-floors exact multiples (0.29
  // → 0.28), which would misclassify a body sitting exactly at baseMinSize as
  // dust and wrongly merge a sellable body (issue #195).
  const roundedFullQty = floorToIncrement(roundAsset(body.assetQty), inc);
  return roundedFullQty < baseMinSize;
};

/**
 * Freeze a body for the Race-3 merge-snapshot maps. Scalars are copied by the
 * spread; `buyOrders` gets its own array so a buy folded onto the live body
 * after the snapshot is not counted among the tranches the snapshot's TP
 * covered (issue #607). The tranche objects stay shared with the live body.
 * @param {Object} body
 * @returns {Object}
 */
const snapshotBody = (body) => ({ ...body, buyOrders: [...(body.buyOrders || [])] });

/**
 * Decide whether a buy-fill handling pass is a RETRY that must be skipped to
 * avoid double-counting (issue #131), vs. a legitimate new tranche (including an
 * advancing partial) that must process. The distinguishing signal is whether
 * any NEW fill rows were ingested this pass: ingestFill dedups by tradeId, so a
 * pure retry ingests nothing (ingestedCount === 0) and re-aggregates the full
 * order, whereas a real new/advancing fill brings new rows (ingestedCount > 0)
 * and must NOT be dropped even though a body already owns the orderId.
 * @param {number} ingestedCount - number of NEW fills ingested this pass
 * @param {Array} bodies - positionState.celestialBodies
 * @param {string} orderId
 * @returns {boolean} true → skip (retry after a body already committed)
 */
const shouldSkipBuyRecommit = (ingestedCount, bodies, orderId) =>
  ingestedCount === 0 && isBuyAlreadyCommitted(bodies, orderId);

module.exports = {
  buildPartialFillData,
  makeFillDedupKey,
  resolveEntryBudget,
  isInsufficientFundsMessage,
  sizeEntry,
  entryOffsetBps,
  isBuyAlreadyCommitted,
  isUnsettledBuyRow,
  collectBuyBookingBatch,
  measureUnbookedOrderQty,
  boundRecoveredBuyRows,
  isFullTpExecution,
  splitTpHoldback,
  pruneStaleTpCancelMarkers,
  isStrandedDustBody,
  snapshotBody,
  shouldSkipBuyRecommit,
};
