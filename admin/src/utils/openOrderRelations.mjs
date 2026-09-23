/**
 * Which buys an open take-profit order is resting against — the expandable
 * "N buys" sub-rows of the RegimeDashboard "Open Orders" table (issue #700).
 *
 * Linkage, first match wins:
 *   1. Body TP: the celestial body's own `buyOrders` (migration artifacts —
 *      zero-qty rows, rows with no orderId, 'core-migration' — are skipped).
 *   2. Live: fill-ledger buys whose `sellOrderId` stamp names this TP. The stamp
 *      and the partial-fill aggregation come from shared/cycle-pairing.mjs — the
 *      same rules the server and the Filled Orders section use — so a buy with
 *      no orderId stays a distinct row (#108) and a stamp on any partial row
 *      links the whole order.
 *   3. Fallback (legacy/core TPs with no stamp):
 *        - dry-run: the simulated buys no core sell has consumed yet
 *          (deriveDryRunFillGroups' `pendingBuys`);
 *        - live: core (non-body) buys since the last core sell, walked
 *          chronologically. Cycles are atomic (CLAUDE.md "P&L model"), so the
 *          walk also restarts at a cycle boundary: a core TP never rests on a
 *          previous cycle's buys.
 *
 * Callers pass the UNFILTERED fill ledger: which buys a resting TP covers must
 * not depend on the Filled Orders "current cycle only" display toggle.
 *
 * Everything that scans fills is done once in buildOpenOrderRelationIndex, so a
 * parent can memoize it on the fill snapshot and the ~1s status tick only pays
 * for map lookups. Pure: inputs are never mutated.
 */
import { pairCycleFills, buyPairKey } from '../../../shared/cycle-pairing.mjs'
import { deriveDryRunFillGroups } from './regimeFillGroups.mjs'
import { computeOpenOrderEstimate } from './openOrderEstimates.mjs'

export const isTpOrderType = (type) =>
  type === 'take_profit' || type === 'satellite_tp' || type === 'body_tp'

const isBodyOwnedFill = (fill) => Boolean(fill.isBodyOwned ?? fill.isSatellite)

const fillQuote = (fill) => fill.quoteAmount || fill.size * fill.price

/**
 * Aggregate buy fill rows (partials of one order) into one display row:
 * { orderId, price, assetQty, sizeUsdc, filledAt } — the shape body.buyOrders
 * already has. Price/filledAt come from the first row, sizes are summed.
 */
function aggregateBuyRows(fills) {
  const rows = new Map()
  fills.forEach(f => {
    const key = buyPairKey(f)
    const ex = rows.get(key)
    if (ex) {
      ex.assetQty += f.size
      ex.sizeUsdc += fillQuote(f)
    } else {
      rows.set(key, { orderId: f.orderId, price: f.price, assetQty: f.size, sizeUsdc: fillQuote(f), filledAt: f.timestamp })
    }
  })
  return rows
}

/** Live fallback: core buys since the last core sell, within the latest cycle run. */
function unconsumedCoreBuys(fills) {
  const sorted = fills
    .filter(f => (f.side === 'buy' || f.side === 'sell') && !isBodyOwnedFill(f))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  let pending = []
  let runCycleId = null
  sorted.forEach(f => {
    if (f.cycleId) {
      if (runCycleId && f.cycleId !== runCycleId) pending = []
      runCycleId = f.cycleId
    }
    if (f.side === 'buy') pending.push(f)
    else pending = []
  })
  return Array.from(aggregateBuyRows(pending).values())
}

const dryRunBuyRow = (o) => ({
  orderId: o.orderId,
  price: o.fillPrice || o.price,
  assetQty: o.size,
  sizeUsdc: (o.size || 0) * (o.fillPrice || o.price || 0),
  filledAt: o.filledAt,
})

/**
 * Build the fill-derived half of the relations once per fill snapshot.
 * @param {object} [opts]
 * @param {object[]} [opts.fills] - unfiltered fill-ledger rows (live mode)
 * @param {object[]} [opts.dryRunFilled] - simulator filledOrders (dry-run mode)
 * @param {boolean} [opts.isDryRun]
 * @returns {{ isDryRun: boolean, buysBySellOrderId: Map<string, object[]>, fallbackBuys: object[] }}
 */
export function buildOpenOrderRelationIndex({ fills, dryRunFilled, isDryRun = false } = {}) {
  if (isDryRun) {
    // The simulator stamps no sellOrderId, so only the chronological fallback applies.
    return {
      isDryRun: true,
      buysBySellOrderId: new Map(),
      fallbackBuys: deriveDryRunFillGroups(dryRunFilled || []).pendingBuys.map(dryRunBuyRow),
    }
  }

  const ledger = fills || []
  const buyFills = ledger.filter(f => f.side === 'buy')
  const rows = aggregateBuyRows(buyFills)
  const buysBySellOrderId = new Map()
  for (const buy of pairCycleFills(buyFills).buys.values()) {
    if (!buy.sellOrderId) continue
    const row = rows.get(buy.key)
    if (!row) continue
    if (!buysBySellOrderId.has(buy.sellOrderId)) buysBySellOrderId.set(buy.sellOrderId, [])
    buysBySellOrderId.get(buy.sellOrderId).push(row)
  }
  return { isDryRun: false, buysBySellOrderId, fallbackBuys: unconsumedCoreBuys(ledger) }
}

/**
 * The buys an open order is resting against (empty for non-TP orders).
 * @param {object} order - open order row ({ orderId, type, ... })
 * @param {object} ctx
 * @param {Map<string, object>} [ctx.bodyLookup] - celestial bodies by tpOrderId
 * @param {ReturnType<typeof buildOpenOrderRelationIndex>} [ctx.index] - prebuilt index;
 *   when omitted one is built from ctx.fills / ctx.dryRunFilled / ctx.isDryRun
 * @param {object[]} [ctx.fills]
 * @param {object[]} [ctx.dryRunFilled]
 * @param {boolean} [ctx.isDryRun]
 * @returns {object[]} rows shaped { orderId, price, assetQty, sizeUsdc, filledAt }
 */
export function relatedBuysForOrder(order, { bodyLookup, index, fills, dryRunFilled, isDryRun } = {}) {
  if (!isTpOrderType(order.type)) return []

  const bodyData = bodyLookup?.get(order.orderId)
  if (bodyData?.buyOrders?.length > 0) {
    const bodyBuys = bodyData.buyOrders.filter(bo => bo.assetQty > 0 && bo.orderId && bo.orderId !== 'core-migration')
    if (bodyBuys.length > 0) return bodyBuys
  }

  const idx = index || buildOpenOrderRelationIndex({ fills, dryRunFilled, isDryRun })
  const linked = idx.buysBySellOrderId.get(order.orderId)
  if (linked?.length > 0) return linked
  return idx.fallbackBuys
}

/**
 * The Open Orders table rows: every `open` order decorated with its estimates
 * (openOrderEstimates.mjs), related buys and age, sorted by price descending.
 * @param {object[]} pendingOrders - status pending orders (any status)
 * @param {object} ctx
 * @param {Map<string, object>} ctx.bodyLookup - celestial bodies by tpOrderId
 * @param {ReturnType<typeof buildOpenOrderRelationIndex>} ctx.index
 * @param {number} [ctx.avgCost] - position.avgCostBasis
 * @param {number} [ctx.holdbackRatio]
 * @param {number} [ctx.feeRatePerSide]
 * @param {number} ctx.now - ms timestamp the ages are measured from
 */
export function deriveOpenOrderRows(pendingOrders, { bodyLookup, index, avgCost, holdbackRatio, feeRatePerSide, now }) {
  return pendingOrders
    .filter(o => o.status === 'open')
    .map(order => {
      const isTpOrder = isTpOrderType(order.type)
      const bodyData = isTpOrder ? bodyLookup.get(order.orderId) : null
      const { estSellFee, estPnl, estHoldback, estHoldbackValue, tpPercent } = computeOpenOrderEstimate(
        order, bodyData, { avgCost, holdbackRatio, feeRatePerSide }
      )
      const relatedBuys = relatedBuysForOrder(order, { bodyLookup, index })
      return { ...order, age: now - order.placedAt, estPnl, estSellFee, estHoldback, estHoldbackValue, tpPercent, relatedBuys }
    })
    .sort((a, b) => (b.price || 0) - (a.price || 0))
}
