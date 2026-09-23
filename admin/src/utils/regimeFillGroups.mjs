import { pairCycleFills, buyPairKey } from '../../../shared/cycle-pairing.mjs'

// Comparator for cycle IDs: 'current' first, numeric cycles descending, 'unknown' last
export function compareCycleIds(a, b) {
  if (a === b) return 0
  if (a === 'current') return -1
  if (b === 'current') return 1
  if (a === 'unknown') return 1
  if (b === 'unknown') return -1
  const numA = parseInt(a.replace('cycle-', '')) || 0
  const numB = parseInt(b.replace('cycle-', '')) || 0
  return numB - numA
}

// Historical cycle accounting only. Callers own snapshot memoization; prices and
// pending orders must not invalidate this derivation. Input fills are never mutated.
//
// Pairing and per-sell pnl/holdback come from shared/cycle-pairing.mjs — the
// SAME rule set the server's computeRealizedFromCyclePairs uses — so the grand
// total here always equals the Position card's realized P&L for the same fills
// (issue #697). Only the row decoration (aggregated buy/sell rows, the bodyId
// display fallback for sells with no linked buys, orphan list) lives here.
export function deriveRegimeFillGroups(filteredFills) {
  const pairing = pairCycleFills(filteredFills)

  // Aggregate partial fills into display rows. Buys use the pairing key so
  // no-orderId rows stay distinct (#108) instead of collapsing under undefined.
  const aggregate = (fills, keyOf) => {
    const m = new Map()
    fills.forEach(f => {
      const key = keyOf(f)
      const ex = m.get(key)
      if (ex) {
        ex.size += f.size; ex.quoteAmount = (ex.quoteAmount || 0) + (f.quoteAmount || 0)
        ex.netFee = (ex.netFee || 0) + (f.netFee || 0); ex.partialCount = (ex.partialCount || 1) + 1
        // Preserve linkage from any partial fill that has it
        if (f.sellOrderId && !ex.sellOrderId) ex.sellOrderId = f.sellOrderId
        if (f.bodyId && !ex.bodyId) ex.bodyId = f.bodyId
      } else m.set(key, { ...f, pairKey: key, partialCount: 1 })
    })
    return m
  }
  const aggBuys = aggregate(filteredFills.filter(f => f.side === 'buy'), buyPairKey)
  const aggSellsAll = Array.from(aggregate(filteredFills.filter(f => f.side === 'sell'), f => f.orderId).values())

  // Display-only fallback: a sell no buy pairs with still shows its body's
  // buys. It never prices the sell — those buys are held open server-side.
  const buysByBodyId = new Map()
  aggBuys.forEach(buy => {
    if (!buy.bodyId) return
    if (!buysByBodyId.has(buy.bodyId)) buysByBodyId.set(buy.bodyId, [])
    buysByBodyId.get(buy.bodyId).push(buy)
  })

  const sellGroups = []
  aggSellsAll.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  aggSellsAll.forEach(order => {
    const priced = pairing.sells.get(order.orderId)
    const linkedBuys = (priced?.buyKeys || []).map(key => aggBuys.get(key)).filter(Boolean)
    const buys = linkedBuys.length > 0
      ? linkedBuys
      : (order.bodyId ? buysByBodyId.get(order.bodyId) || [] : [])
    const sell = { ...order, pnl: priced?.pnl ?? null, holdback: priced?.holdback ?? 0 }
    sellGroups.push({ sell, buys, key: `fill-${order.orderId}` })
  })
  sellGroups.reverse()

  // Find unclaimed buys: not linked to any filled sell
  // Include body-owned buys whose TP isn't in the Open Orders section
  const claimedBuyKeys = new Set()
  sellGroups.forEach(g => g.buys.forEach(b => claimedBuyKeys.add(b.pairKey)))
  const orphanCandidates = Array.from(aggBuys.values())
    .filter(b => !claimedBuyKeys.has(b.pairKey))
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
  const cycleGroups = Array.from(cycleMap.values()).sort((a, b) => compareCycleIds(a.cycleId, b.cycleId))
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

// Chronological order for dry-run simulated orders (fill time, else placement time).
const dryRunTime = (order) => order.filledAt || order.placedAt || 0

// A dry-run sell that belongs to a celestial body (its own TP) rather than the core position.
const isDryRunBodySell = (order) =>
  Boolean(order.isBodyOwned ?? order.isSatellite) || order.type === 'satellite_tp' || order.type === 'body_tp'

function summarizeDryRunSellGroups(sellGroups) {
  const totalPnl = sellGroups.reduce((sum, group) => sum + (group.sell.pnl || 0), 0)
  const totalHoldback = sellGroups.reduce((sum, group) => sum + (group.sell.holdbackAsset || 0), 0)
  return { totalPnl, totalHoldback }
}

// Dry-run Filled Orders. The simulator's filledOrders carry no fill-ledger
// linkage (no sellOrderId/bodyId on buys), so pairing is a chronological walk:
// buys accumulate until a CORE sell consumes them; a body sell (body_tp /
// satellite_tp / body-owned) consumes nothing and is shown with no buys. The
// simulator already priced every sell (pnl / holdbackAsset), so this only
// groups rows. `pendingBuys` are the buys no core sell has consumed yet — the
// buys an open core TP is resting against. Input is never mutated.
export function deriveDryRunFillGroups(filledOrders = []) {
  const sorted = [...filledOrders].sort((a, b) => dryRunTime(a) - dryRunTime(b))
  const sellGroups = []
  let pendingBuys = []
  sorted.forEach(order => {
    if (order.side === 'buy') {
      pendingBuys.push(order)
    } else if (isDryRunBodySell(order)) {
      sellGroups.push({ sell: order, buys: [], key: `fill-${order.orderId}` })
    } else {
      sellGroups.push({ sell: order, buys: pendingBuys, key: `fill-${order.orderId}` })
      pendingBuys = []
    }
  })
  sellGroups.reverse()
  return { sellGroups, pendingBuys, ...summarizeDryRunSellGroups(sellGroups) }
}

export function searchDryRunFillGroups(history, search) {
  if (!search) return history
  const query = search.toLowerCase()
  const sellGroups = history.sellGroups.filter(group =>
    group.sell.orderId?.toLowerCase().includes(query) ||
    group.buys.some(buy => buy.orderId?.toLowerCase().includes(query)))
  return { ...history, sellGroups, ...summarizeDryRunSellGroups(sellGroups) }
}
