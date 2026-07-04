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

  // Pre-compute total sell value per orderId (for proportional P&L on multi-fill
  // orders) and capture the server-annotated bodyPnl/satellitePnl/holdback/cost-basis
  // ONCE per orderId — taking the first non-null value here (not summing across
  // rows) avoids multiplying Total P&L and Holdback by the number of partial fills.
  const sellTotalsByOrderId = new Map()
  for (const fill of chronological) {
    if (fill.side !== 'sell') continue
    const fillValue = fill.quoteAmount || fill.size * fill.price
    const annotatedPnl = fill.bodyPnl ?? fill.satellitePnl
    const annotatedHoldback = fill.bodyHoldbackAsset ?? fill.satelliteHoldbackAsset
    const annotatedCostBasis = fill.bodyCostBasis ?? fill.satelliteCostBasis
    const prev = sellTotalsByOrderId.get(fill.orderId)
    if (prev) {
      prev.totalQuote += fillValue
      prev.totalFee += fill.netFee || fill.fee || 0
      if (prev.annotatedPnl == null && annotatedPnl != null) prev.annotatedPnl = annotatedPnl
      if (prev.annotatedHoldback == null && annotatedHoldback != null) prev.annotatedHoldback = annotatedHoldback
      if (prev.annotatedCostBasis == null && annotatedCostBasis != null) prev.annotatedCostBasis = annotatedCostBasis
    } else {
      sellTotalsByOrderId.set(fill.orderId, {
        totalQuote: fillValue,
        totalFee: fill.netFee || fill.fee || 0,
        annotatedPnl: annotatedPnl ?? null,
        annotatedHoldback: annotatedHoldback ?? null,
        annotatedCostBasis: annotatedCostBasis ?? null,
      })
    }
  }

  let totalBtc = 0
  let totalCost = 0
  const pnlMap = new Map()

  for (let i = 0; i < chronological.length; i++) {
    const fill = chronological[i]
    if (fill.side === 'buy') {
      const isBody = fill.isBodyOwned || fill.isSatellite || fill.bodyId
      if (!isBody) {
        totalBtc += fill.size
        totalCost += (fill.quoteAmount || fill.size * fill.price) + (fill.netFee || fill.fee || 0)
      }
      pnlMap.set(i, { pnl: null, holdbackAsset: null, holdbackValue: null, avgCost: totalBtc > 0 ? totalCost / totalBtc : 0 })
      continue
    }
    // Sell fill
    const isBody = fill.isBodyOwned || fill.isSatellite || fill.bodyId
    const orderTotals = sellTotalsByOrderId.get(fill.orderId)
    const fillValue = fill.quoteAmount || fill.size * fill.price
    // This partial fill's share of its order's total sell value. Used to
    // prorate once-per-orderId annotations across partial rows so the
    // per-row values sum back to the single annotated total (not N× it).
    const fillShare = orderTotals && orderTotals.totalQuote > 0 ? fillValue / orderTotals.totalQuote : 1
    let pnl

    if (orderTotals?.annotatedPnl != null) {
      // 1. Server-annotated P&L (most trusted) — prorate the once-per-order
      // value across this order's partial fills for display/summation.
      pnl = orderTotals.annotatedPnl * fillShare
    } else {
      // 2. Try buy-sell linkage via sellOrderId
      const linkedBuys = buysBySellId.get(fill.orderId)
      if (linkedBuys && linkedBuys.length > 0) {
        const buyCost = linkedBuys.reduce((s, b) => s + (b.quoteAmount || b.size * b.price) + (b.netFee || b.fee || 0), 0)
        const totalSellProceeds = orderTotals.totalQuote - orderTotals.totalFee
        const totalPnl = totalSellProceeds - buyCost
        // Distribute proportionally for multi-fill orders
        pnl = totalPnl * fillShare
      } else if (isBody && orderTotals?.annotatedCostBasis) {
        // 3. Body/satellite sell with cost basis annotation but no P&L.
        // The cost basis is also annotated once per orderId, so prorate it
        // across partials before subtracting from this row's own proceeds.
        const proratedCostBasis = orderTotals.annotatedCostBasis * fillShare
        pnl = (fillValue - (fill.netFee || fill.fee || 0)) - proratedCostBasis
      } else {
        // 4. Fallback: running avg for truly unlinked core sells
        const avgCost = totalBtc > 0 ? totalCost / totalBtc : 0
        const proceeds = fillValue - (fill.netFee || fill.fee || 0)
        pnl = proceeds - avgCost * fill.size
      }
    }

    // Holdback is likewise annotated once per orderId — prorate across partials.
    const annotatedHoldbackTotal = orderTotals?.annotatedHoldback
    const holdbackAsset = annotatedHoldbackTotal != null && annotatedHoldbackTotal > 0
      ? annotatedHoldbackTotal * fillShare
      : null
    const holdbackValue = holdbackAsset != null ? holdbackAsset * fill.price : 0

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

    pnlMap.set(i, { pnl, holdbackAsset, holdbackValue: holdbackValue > 0 ? holdbackValue : null, avgCost: totalBtc > 0 ? totalCost / totalBtc : 0 })
  }

  return chronological.map((fill, i) => ({ ...fill, ...pnlMap.get(i) }))
}
