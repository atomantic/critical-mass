import { buyFillCost, feeOf, quoteOf, isBodyOwnedFill, foldSellAnnotations } from './cycle-pairing.mjs';

// Pure P&L aggregation for the Transactions (Regime) view.
//
// The engine writes server-annotated bodyPnl/satellitePnl/bodyHoldbackAsset/
// bodyCostBasis identically to EVERY partial-fill row of the same orderId
// (see src/fill-ledger.js:1243-1245 and the project CLAUDE.md P&L section:
// "don't sum bodyPnl across an orderId's partial fill rows — it multiplies
// pnl by N"). Summing per row would therefore multiply Total P&L and
// Holdback by the number of partial fills for any TP that filled in N
// pieces. This module takes each annotation ONCE per orderId and prorates
// it across that order's partial rows, so:
//   - per-row display shows a fair (prorated) share instead of the whole
//     order's value repeated on every partial, and
//   - summing the prorated shares across all rows of an order reproduces
//     exactly the single annotated total (not N× it) — matching
//     RegimeDashboard.jsx and fill-ledger.js:computeRealizedFromCyclePairs.
//
// Exported as a standalone pure function (no React) so it can be unit
// tested directly.
export function computeFillsWithPnL(fills) {
  // Use ALL fills for P&L calculation (not just the currently-filtered
  // subset) so the running-avg fallback and orderId aggregation are correct.
  const chronological = [...fills].sort((a, b) => a.timestamp - b.timestamp)

  // Build buy→sell linkage map: buys annotated with sellOrderId point to their matching sell
  const buysBySellId = new Map()
  for (const fill of chronological) {
    if (fill.side === 'buy' && fill.sellOrderId) {
      if (!buysBySellId.has(fill.sellOrderId)) buysBySellId.set(fill.sellOrderId, [])
      buysBySellId.get(fill.sellOrderId).push(fill)
    }
  }

  // Take annotations once in chronological order, preserving the view's
  // first-wins semantics even when the ledger arrived out of order.
  const sellTotalsByOrderId = foldSellAnnotations(chronological)

  let totalBtc = 0
  let totalCost = 0
  const pnlMap = new Map()

  for (let i = 0; i < chronological.length; i++) {
    const fill = chronological[i]
    if (fill.side === 'buy') {
      const isBody = isBodyOwnedFill(fill)
      if (!isBody) {
        totalBtc += fill.size
        totalCost += buyFillCost(fill)
      }
      pnlMap.set(i, { pnl: null, holdbackAsset: null, holdbackValue: null, avgCost: totalBtc > 0 ? totalCost / totalBtc : 0 })
      continue
    }
    // Sell fill
    const isBody = isBodyOwnedFill(fill)
    const orderTotals = sellTotalsByOrderId.get(fill.orderId)
    const fillValue = quoteOf(fill)
    // This partial fill's share of its order's total sell value. Used to
    // prorate once-per-orderId annotations across partial rows so the
    // per-row values sum back to the single annotated total (not N× it).
    const fillShare = orderTotals && orderTotals.quote > 0 ? fillValue / orderTotals.quote : 1
    const pnl = sellPnlForRow(fill, orderTotals, buysBySellId.get(fill.orderId), fillShare, fillValue, isBody, totalBtc, totalCost)

    // Holdback is likewise annotated once per orderId — prorate across partials.
    // Net of reserves a stale TP sold beyond its body (#770), so this page's
    // holdback total matches the server's realizedAssetPnL; negative when the
    // sale drew reserves down.
    const annotatedHoldbackTotal = orderTotals?.holdback
    const netHoldbackTotal = (annotatedHoldbackTotal > 0 ? annotatedHoldbackTotal : 0) - (orderTotals?.reservesSold || 0)
    const holdbackAsset = netHoldbackTotal !== 0 ? netHoldbackTotal * fillShare : null
    const holdbackValue = holdbackAsset != null ? holdbackAsset * fill.price : null

    // Update running position for non-body sells without linkage (core TP)
    if (!isBody && !buysBySellId.has(fill.orderId)) {
      const remainingBtc = totalBtc - fill.size
      if (remainingBtc > 0) {
        const avgCost = totalBtc > 0 ? totalCost / totalBtc : 0
        totalBtc = remainingBtc
        totalCost = avgCost * remainingBtc
      } else {
        totalBtc = 0
        totalCost = 0
      }
    }

    pnlMap.set(i, { pnl, holdbackAsset, holdbackValue, avgCost: totalBtc > 0 ? totalCost / totalBtc : 0 })
  }

  return chronological.map((fill, i) => ({ ...fill, ...pnlMap.get(i) }))
}

// Preserve the trust order: annotation, explicit buy linkage, annotated cost,
// then the running-average fallback for unlinked rows.
function sellPnlForRow(fill, orderTotals, linkedBuys, fillShare, fillValue, isBody, totalBtc, totalCost) {
  if (orderTotals?.pnl != null) {
    // 1. Server-annotated P&L, prorated across the order's partial rows.
    return orderTotals.pnl * fillShare
  }
  if (linkedBuys && linkedBuys.length > 0) {
    // 2. Explicit buy-sell linkage, distributed by sell value.
    const buyCost = linkedBuys.reduce((s, b) => s + buyFillCost(b), 0)
    const totalSellProceeds = orderTotals.quote - orderTotals.fee
    const totalPnl = totalSellProceeds - buyCost
    return totalPnl * fillShare
  }
  if (isBody && orderTotals?.costBasis) {
    // 3. Once-per-order cost annotation, prorated before row subtraction.
    const proratedCostBasis = orderTotals.costBasis * fillShare
    return (fillValue - feeOf(fill)) - proratedCostBasis
  }
  // 4. Running average for truly unlinked core sells.
  const avgCost = totalBtc > 0 ? totalCost / totalBtc : 0
  const proceeds = fillValue - feeOf(fill)
  return proceeds - avgCost * fill.size
}
