// Historical cycle accounting only. Callers own snapshot memoization; prices and
// pending orders must not invalidate this derivation. Input fills are never mutated.
export function deriveRegimeFillGroups(filteredFills) {
  const sellGroups = []
  // Live: sellOrderId-based grouping with chronological fallback
  // First aggregate partial fills by orderId
  const aggregateByOrderId = (fills) => {
    const m = new Map()
    fills.forEach(f => {
      const ex = m.get(f.orderId)
      if (ex) {
        ex.size += f.size; ex.quoteAmount = (ex.quoteAmount || 0) + (f.quoteAmount || 0)
        ex.netFee = (ex.netFee || 0) + (f.netFee || 0); ex.partialCount = (ex.partialCount || 1) + 1
        // Preserve sellOrderId from any partial fill that has it
        if (f.sellOrderId && !ex.sellOrderId) ex.sellOrderId = f.sellOrderId
      } else m.set(f.orderId, { ...f, partialCount: 1 })
    })
    return Array.from(m.values())
  }

  // P&L: per-sell computation from bodyPnl annotations. The annotation
  // is written to EVERY partial-fill row of the same orderId — take it
  // ONCE per orderId, not summed (summing multiplies pnl by N partials).
  // Mirrors fill-ledger.js:computeRealizedFromCyclePairs.
  const pnlMap = new Map()
  filteredFills.forEach(fill => {
    if (fill.side === 'sell') {
      const bodyPnl = fill.bodyPnl ?? fill.satellitePnl
      const holdback = (fill.bodyHoldbackAsset ?? fill.satelliteHoldbackAsset) || 0
      const prev = pnlMap.get(fill.orderId)
      if (prev) {
        prev.proceeds += (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0)
        prev.totalSold += fill.size
        if (!prev.hasAnnotation && bodyPnl != null) { prev.pnl = bodyPnl; prev.holdback = holdback; prev.hasAnnotation = true }
      } else {
        pnlMap.set(fill.orderId, {
          // null (not 0) when unannotated, so the group-level
          // prorated fallback below prices it — seeding 0 would
          // make `sell.pnl != null` true and skip the fallback,
          // rendering a real sell as $0.00 (#111 review).
          pnl: bodyPnl ?? null,
          holdback,
          hasAnnotation: bodyPnl != null,
          proceeds: (fill.quoteAmount || fill.size * fill.price) - (fill.netFee || fill.fee || 0),
          totalSold: fill.size,
        })
      }
    }
  })

  // Per-sell P&L: annotated sells keep their once-per-orderId
  // bodyPnl/satellitePnl (set above); non-annotated sells are
  // left null here and priced by the prorated group-level
  // fallback below (which links buys by sellOrderId AND the
  // bodyId redirect, so it covers more sells than a raw
  // sellOrderId-only walk would).

  // Aggregate fills by orderId
  const aggBuysAll = aggregateByOrderId(filteredFills.filter(f => f.side === 'buy'))
  const aggSellsAll = aggregateByOrderId(filteredFills.filter(f => f.side === 'sell'))

  // Group all buys by sellOrderId for direct lookup
  const buysBySellOrderId = new Map()
  aggBuysAll.forEach(buy => {
    const sid = buy.sellOrderId
    if (!sid) return
    if (!buysBySellOrderId.has(sid)) buysBySellOrderId.set(sid, [])
    buysBySellOrderId.get(sid).push(buy)
  })

  // Redirect orphaned buys (sellOrderId points to non-existent sell) to real sell via bodyId
  // This handles TP re-placement: buys linked to old TP orderId get redirected to the actual fill
  const knownSellIds = new Set(aggSellsAll.map(s => s.orderId))
  const sellIdByBodyId = new Map()
  aggSellsAll.forEach(s => { if (s.bodyId) sellIdByBodyId.set(s.bodyId, s.orderId) })
  // Learn bodyId from any annotated buy sharing an orphaned sellOrderId
  const bodyIdByOrphanSellId = new Map()
  aggBuysAll.forEach(buy => {
    if (buy.sellOrderId && !knownSellIds.has(buy.sellOrderId) && buy.bodyId) {
      bodyIdByOrphanSellId.set(buy.sellOrderId, buy.bodyId)
    }
  })
  // Redirect orphaned buys to real sell
  aggBuysAll.forEach(buy => {
    const sid = buy.sellOrderId
    if (!sid || knownSellIds.has(sid)) return
    const bodyId = buy.bodyId || bodyIdByOrphanSellId.get(sid)
    if (!bodyId) return
    const realSellId = sellIdByBodyId.get(bodyId)
    if (!realSellId) return
    if (!buysBySellOrderId.has(realSellId)) buysBySellOrderId.set(realSellId, [])
    // Avoid duplicates (buy may already be in list from bodyId annotation)
    const existing = buysBySellOrderId.get(realSellId)
    if (!existing.some(b => b.orderId === buy.orderId)) existing.push(buy)
  })

  // Fallback: group buys by bodyId for sells with no sellOrderId linkage
  const buysByBodyId = new Map()
  aggBuysAll.forEach(buy => {
    if (!buy.bodyId) return
    if (!buysByBodyId.has(buy.bodyId)) buysByBodyId.set(buy.bodyId, [])
    buysByBodyId.get(buy.bodyId).push(buy)
  })

  // Build sell groups: sellOrderId first, bodyId fallback, uniform for all sell types
  aggSellsAll.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  aggSellsAll.forEach(order => {
    const pnlData = pnlMap.get(order.orderId)
    const sell = { ...order, pnl: pnlData?.pnl ?? null, holdback: pnlData?.holdback ?? null }
    const linkedBuys = buysBySellOrderId.get(order.orderId)
    const bodyBuys = (!linkedBuys || linkedBuys.length === 0) && order.bodyId
      ? buysByBodyId.get(order.bodyId) || []
      : null
    const buys = linkedBuys || bodyBuys || []
    // For body sells, prefer server-annotated holdback (computed from exact body.assetQty)
    // Only fall back to buy-sell size diff when no server annotation exists
    if ((sell.isBodyOwned ?? sell.isSatellite) && (sell.bodyHoldbackAsset ?? sell.satelliteHoldbackAsset) != null) {
      sell.holdback = sell.bodyHoldbackAsset ?? sell.satelliteHoldbackAsset
    } else if (buys.length > 0) {
      const buyTotal = buys.reduce((s, b) => s + (b.size || 0), 0)
      sell.holdback = Math.max(0, buyTotal - (sell.size || 0))
    }
    sellGroups.push({ sell, buys, key: `fill-${order.orderId}` })
  })
  sellGroups.reverse()

  // P&L is already resolved per sell in pnlMap above: the
  // bodyPnl/satellitePnl annotation (engine's PRORATED cost
  // basis) is taken once per orderId when present, else a
  // prorated buy-walk fallback. sell.pnl was copied from there.
  // Only fill in a value when it's still null — e.g. the richer
  // bodyId-redirect linkage here found buys the first pass
  // missed — and PRORATE it (use Σbuy_unitCost × sold_qty), never
  // proceeds − full linked-buy cost. Charging the held-back
  // portion's cost (the old recompute) understated each row vs
  // the engine's realizedPnL and made the grand total disagree
  // with the Position card (#111).
  sellGroups.forEach(group => {
    if (group.sell.pnl != null) return
    if (group.buys.length === 0) return
    const buys = [...group.buys].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    let remain = group.sell.size || 0
    let buyCost = 0
    for (const b of buys) {
      if (remain <= 0) break
      const use = Math.min(remain, b.size || 0)
      const unitCost = b.size > 0 ? ((b.quoteAmount || b.size * b.price) + (b.netFee || b.fee || 0)) / b.size : 0
      buyCost += use * unitCost
      remain -= use
    }
    const sellProceeds = (group.sell.quoteAmount || group.sell.size * group.sell.price) - (group.sell.netFee || group.sell.fee || 0)
    group.sell.pnl = sellProceeds - buyCost
  })

  // Find unclaimed buys: not linked to any filled sell
  // Include body-owned buys whose TP isn't in the Open Orders section
  const claimedBuyIds = new Set()
  sellGroups.forEach(g => g.buys.forEach(b => claimedBuyIds.add(b.orderId)))
  const orphanCandidates = aggBuysAll
    .filter(b => !claimedBuyIds.has(b.orderId))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  return { sellGroups, orphanCandidates, ...summarizeRegimeFillGroups(sellGroups) }
}

export function summarizeRegimeFillGroups(sellGroups) {
  const cycleMap = new Map()
  sellGroups.forEach(group => {
    const cid = group.sell.cycleId || 'unknown'
    if (!cycleMap.has(cid)) cycleMap.set(cid, { cycleId: cid, sells: [], totalSize: 0, totalPnl: 0, totalHoldback: 0, buyCount: 0, minTs: Infinity, maxTs: 0 })
    const entry = cycleMap.get(cid)
    entry.sells.push(group)
    entry.totalSize += group.sell.size || 0
    entry.totalPnl += group.sell.pnl || 0
    // Sum live per-sell realized holdback.
    entry.totalHoldback += group.sell.holdback || 0
    entry.buyCount += group.buys.length
    const sellTs = group.sell.timestamp || group.sell.filledAt || 0
    if (sellTs > 0) { entry.minTs = Math.min(entry.minTs, sellTs); entry.maxTs = Math.max(entry.maxTs, sellTs) }
    group.buys.forEach(b => {
      const buyTs = b.timestamp || b.filledAt || 0
      if (buyTs > 0) { entry.minTs = Math.min(entry.minTs, buyTs); entry.maxTs = Math.max(entry.maxTs, buyTs) }
    })
  })
  // Reserves = sum of per-cycle holdback (asset bought but not included in
  // the paired sell). Derived from cycle pairs, same source as totalPnl.
  let totalHoldback = 0
  cycleMap.forEach(entry => { totalHoldback += entry.totalHoldback })
  const cycleGroups = Array.from(cycleMap.values()).sort((a, b) => {
    if (a.cycleId === 'unknown') return 1
    if (b.cycleId === 'unknown') return -1
    const numA = parseInt(a.cycleId.replace('cycle-', '')) || 0
    const numB = parseInt(b.cycleId.replace('cycle-', '')) || 0
    return numB - numA
  })
  const totalPnl = sellGroups.reduce((sum, group) => sum + (group.sell.pnl || 0), 0)
  return { cycleGroups, totalHoldback, totalPnl }
}

export function visibleOrphanBuys(orphanCandidates, pendingOrders) {
  const bodiesWithActiveTp = new Set(pendingOrders
    .filter(order => order.status === 'open' && order.bodyId)
    .map(order => order.bodyId))
  return orphanCandidates.filter(buy => !(buy.bodyId && bodiesWithActiveTp.has(buy.bodyId)))
}

export function searchRegimeFillGroups(history, search) {
  if (!search) return history
  const query = search.toLowerCase()
  const sellGroups = history.sellGroups.filter(group =>
    group.sell.orderId?.toLowerCase().includes(query) ||
    group.buys.some(buy => buy.orderId?.toLowerCase().includes(query)))
  const orphanCandidates = history.orphanCandidates.filter(buy =>
    buy.orderId?.toLowerCase().includes(query))
  return { sellGroups, orphanCandidates, ...summarizeRegimeFillGroups(sellGroups) }
}
