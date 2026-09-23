/**
 * Pure estimation math for the RegimeDashboard "Open Orders" table.
 *
 * These are CLIENT-SIDE ESTIMATES of what the engine already computed when it placed
 * the order — they must mirror src/position-sizer.js's calculateTakeProfitSize and
 * src/regime-engine.js's placeBodyTp fee handling, or the dashboard misleads operators
 * judging Collapse-All / manual TP edits. See issue #698.
 *
 * Two things the naive formula gets wrong if not careful:
 *  - Fee rate: the engine budgets `config.feeRate || 0.001` (10 bps), not a hard-coded
 *    6 bps guess.
 *  - Holdback: for a body TP, the exact planned holdback is already known —
 *    `body.assetQty - order.size` (CLAUDE.md: don't conflate body.assetQty with the TP
 *    size; here the difference IS the holdback, so use it instead of re-deriving a ratio).
 *    The ratio formula (inverted from the engine's `H = (S+H)(P-C)r/P`) is only needed
 *    as a fallback for non-body/legacy TPs, where it must still apply the tier's
 *    holdbackScale (capped at 0.95) exactly as position-sizer.js does.
 */

// Holdback scale per tier — mirrors the `holdbackScale` field of TIERS in
// src/celestial-hierarchy.js. Kept in sync manually, same pattern already used by
// admin/src/components/celestial/celestialConstants.js for tier colors/emojis/etc.
export const TIER_HOLDBACK_SCALE = {
  satellite: 1.00,
  asteroid: 1.02,
  moon: 1.05,
  planet: 1.10,
  sun: 1.15,
  hypergiant: 1.20,
  nebula: 1.21,
  galaxy: 1.22,
  black_hole: 1.25,
}

// Matches the engine's conservative default in regime-engine.js placeBodyTp
// (`config.feeRate || 0.001`).
export const DEFAULT_FEE_RATE_PER_SIDE = 0.001

const isTpOrderType = (type) =>
  type === 'take_profit' || type === 'satellite_tp' || type === 'body_tp'

/**
 * @param {object} order - open order row: { type, size, price, orderId, tpPercent,
 *   bodyAvgCost|satelliteAvgCost, bodyCostBasis|satelliteCostBasis, bodyBtcQty|satelliteBtcQty }
 * @param {object|null|undefined} bodyData - matching celestial body (bodyLookup.get(order.orderId)),
 *   or null/undefined when this order has no tracked body (legacy/core TP)
 * @param {object} [ctx]
 * @param {number} [ctx.avgCost] - position.avgCostBasis, used as a fallback avg cost for
 *   non-body TPs
 * @param {number} [ctx.holdbackRatio] - base config.holdbackRatio (pre-tier-scale)
 * @param {number} [ctx.feeRatePerSide] - config.feeRatePerSide ?? config.feeRate; falls
 *   back to DEFAULT_FEE_RATE_PER_SIDE
 * @returns {{estSellFee: number|null, estPnl: number|null, estHoldback: number|null, estHoldbackValue: number|null, tpPercent: string|number|null}}
 */
export const computeOpenOrderEstimate = (order, bodyData, ctx = {}) => {
  const {
    avgCost = 0,
    holdbackRatio = 0.5,
    feeRatePerSide = DEFAULT_FEE_RATE_PER_SIDE,
  } = ctx

  const isTpOrder = isTpOrderType(order.type)
  const orderAvgCost = (order.bodyAvgCost ?? order.satelliteAvgCost) || bodyData?.avgPrice || (isTpOrder ? avgCost : 0)
  const sellValue = order.size * order.price
  const estSellFee = sellValue * feeRatePerSide

  const satCostBasis = (order.bodyCostBasis ?? order.satelliteCostBasis) || bodyData?.costBasis
  const satBtcQty = (order.bodyBtcQty ?? order.satelliteBtcQty) || bodyData?.assetQty
  const proratedCost = satCostBasis && satBtcQty
    ? (satCostBasis / satBtcQty) * order.size
    : null
  const estPnl = isTpOrder && orderAvgCost > 0
    ? (sellValue - estSellFee) - (proratedCost || orderAvgCost * order.size)
    : null

  const profitPerAsset = order.price - orderAvgCost

  // Exact planned holdback for body TPs: body.assetQty is the body's total asset
  // (pre-TP), order.size is the TP's assetOnOrder (post-holdback) — no ratio algebra
  // needed. Only fall back to the ratio formula when we lack that exact figure.
  // Use >= (not >), clamped at 0: when the exchange-minimum guard in placeBodyTp
  // (regime-engine.js) sells the full body with zero holdback, assetQty === order.size
  // exactly, and that must report an exact 0 rather than falling through to the ratio
  // formula's nonzero guess.
  let estHoldback = null
  if (bodyData && typeof bodyData.assetQty === 'number' && bodyData.assetQty >= order.size) {
    estHoldback = Math.max(bodyData.assetQty - order.size, 0)
  } else if (isTpOrder && profitPerAsset > 0) {
    const tierScale = (bodyData?.tier && TIER_HOLDBACK_SCALE[bodyData.tier]) || 1.0
    const scaledHoldbackRatio = Math.min(holdbackRatio * tierScale, 0.95)
    const denominator = order.price * (1 - scaledHoldbackRatio) + orderAvgCost * scaledHoldbackRatio
    estHoldback = denominator > 0
      ? (order.size * profitPerAsset * scaledHoldbackRatio) / denominator
      : null
  }

  const estHoldbackValue = estHoldback ? estHoldback * order.price : null

  const tpPercent = order.tpPercent
    || (((order.type === 'satellite_tp' || order.type === 'body_tp' || (order.type === 'take_profit' && bodyData)) && orderAvgCost > 0)
      ? ((order.price - orderAvgCost) / orderAvgCost * 100).toFixed(2)
      : null)

  return { estSellFee, estPnl, estHoldback, estHoldbackValue, tpPercent }
}
