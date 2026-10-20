import { buyPairKey, pairCycleFills, quoteOf } from './cycle-pairing.mjs'

const MAX_CYCLES = 250
const MAX_POINTS = 500
const MAX_DETAIL_FILLS = 500
const MAX_OPEN_FILLS = 100
const FIELDS = [
  'tradeId', 'orderId', 'timestamp', 'filledAt', 'cycleId', 'side', 'size', 'price',
  'quoteAmount', 'fee', 'netFee', 'sellOrderId', 'bodyId', 'isBodyOwned', 'isSatellite',
  'bodyPnl', 'satellitePnl', 'bodyHoldbackAsset', 'satelliteHoldbackAsset',
  'bodyReservesSoldAsset', 'bodyCostBasis', 'satelliteCostBasis', 'duplicateTpNote',
  'untrackedSell', 'fillTimeMs',
]
const project = row => Object.fromEntries(FIELDS.filter(field => field in row).map(field => [field, row[field]]))
const cycleNumber = id => parseInt((id || '').replace('cycle-', ''), 10) || 0
const liveCycleNumber = id => /^cycle-(\d+)$/.test(id || '') ? Number(id.slice(6)) : -1
const compareCycles = (a, b) => {
  if (a === b) return 0
  if (a === 'current') return -1
  if (b === 'current') return 1
  if (a === 'unknown') return 1
  if (b === 'unknown') return -1
  return cycleNumber(b) - cycleNumber(a)
}
const time = row => {
  const value = row.timestamp || row.filledAt || 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.isFinite(Number(value)) ? Number(value) : Date.parse(value) || 0
  return 0
}

// Runs only when createTransactionsReadView advances its ledger revision.
// Pairing remains owned by the shared cycle rules; this projection never
// mutates fill rows or trading state.
export function aggregateRegimeFills(rows) {
  const pairing = pairCycleFills(rows)
  const cycles = new Map()
  const buysByKey = new Map()
  const sellsByOrder = new Map()
  let buyCount = 0
  let sellCount = 0
  for (const row of rows) {
    const id = row.cycleId || 'current'
    let cycle = cycles.get(id)
    if (!cycle) {
      cycle = { cycleId: id, entryCount: 0, exitCount: 0, totalBought: 0, totalSold: 0,
        totalCost: 0, totalProceeds: 0, totalPnl: 0, totalHoldback: 0,
        buyCount: 0, sellCount: 0, minTs: null, maxTs: null }
      cycles.set(id, cycle)
    }
    const ts = time(row)
    if (ts > 0) {
      cycle.minTs = cycle.minTs == null ? ts : Math.min(cycle.minTs, ts)
      cycle.maxTs = cycle.maxTs == null ? ts : Math.max(cycle.maxTs, ts)
    }
    if (row.side === 'buy') {
      buyCount++
      cycle.entryCount++
      cycle.totalBought += row.size || 0
      // Match the Cost Basis view's existing raw-fill formula. Its cycle
      // breakdown is distinct from paired realized P&L above.
      cycle.totalCost += quoteOf(row) + (row.netFee || 0)
      const key = buyPairKey(row)
      if (!buysByKey.has(key)) buysByKey.set(key, [])
      buysByKey.get(key).push(row)
    } else if (row.side === 'sell') {
      sellCount++
      cycle.exitCount++
      cycle.totalSold += row.size || 0
      cycle.totalProceeds += quoteOf(row) - (row.netFee || 0)
      if (!sellsByOrder.has(row.orderId)) sellsByOrder.set(row.orderId, [])
      sellsByOrder.get(row.orderId).push(row)
    }
  }

  // The existing chart dates each aggregated sell at its first partial fill.
  const firstSellTime = sell => time(sellsByOrder.get(sell.orderId)?.[0] || {})
  const orderedSells = [...pairing.sells.values()].sort((a, b) => firstSellTime(a) - firstSellTime(b))
  const buyKeysByBody = new Map()
  for (const buy of pairing.buys.values()) {
    if (!buy.bodyId) continue
    if (!buyKeysByBody.has(buy.bodyId)) buyKeysByBody.set(buy.bodyId, [])
    buyKeysByBody.get(buy.bodyId).push(buy.key)
  }
  const fillCycleMap = new Map()
  let cumulative = 0
  const allPoints = []
  for (const sell of orderedSells) {
    const displayBuyKeys = sell.buyKeys.length ? sell.buyKeys : (buyKeysByBody.get(sell.bodyId) || [])
    const cycle = cycles.get(sellsByOrder.get(sell.orderId)?.[0]?.cycleId || 'current')
    if (cycle) {
      cycle.sellCount++
      cycle.buyCount += displayBuyKeys.length
      cycle.totalPnl += sell.pnl || 0
      cycle.totalHoldback += sell.holdback - sell.reservesSold
    }
    const groupId = sellsByOrder.get(sell.orderId)?.[0]?.cycleId || 'unknown'
    let group = fillCycleMap.get(groupId)
    if (!group) {
      group = { cycleId: groupId, totalSize: 0, totalPnl: 0, totalHoldback: 0,
        buyCount: 0, sellCount: 0, minTs: null, maxTs: null }
      fillCycleMap.set(groupId, group)
    }
    group.sellCount++
    group.totalSize += sell.size
    group.totalPnl += sell.pnl || 0
    group.totalHoldback += sell.holdback - sell.reservesSold
    group.buyCount += displayBuyKeys.length
    for (const row of [...(sellsByOrder.get(sell.orderId) || []), ...displayBuyKeys.flatMap(key => buysByKey.get(key) || [])]) {
      const ts = time(row)
      if (ts > 0) {
        group.minTs = group.minTs == null ? ts : Math.min(group.minTs, ts)
        group.maxTs = group.maxTs == null ? ts : Math.max(group.maxTs, ts)
      }
    }
    if (sell.pnl != null) {
      cumulative += sell.pnl
      allPoints.push({ timestamp: firstSellTime(sell), pnl: sell.pnl, cumulative })
    }
  }
  const pnlPoints = allPoints.length <= MAX_POINTS ? allPoints
    : Array.from({ length: MAX_POINTS }, (_, i) => allPoints[Math.floor(i * (allPoints.length - 1) / (MAX_POINTS - 1))])
  const sortedCycles = [...cycles.values()].sort((a, b) => compareCycles(a.cycleId, b.cycleId))
  const fillCycleGroups = [...fillCycleMap.values()].sort((a, b) => compareCycles(a.cycleId, b.cycleId))
  const latestCycleId = [...cycles.keys()].filter(id => id !== 'current')
    .sort((a, b) => cycleNumber(b) - cycleNumber(a))[0] || null

  // Details are deliberately a separate, bounded projection. Include buys
  // paired with recent sells even when their fill timestamps are much older.
  const detail = new Map()
  const add = row => {
    if (detail.size >= MAX_DETAIL_FILLS) return
    const display = project(row)
    const paired = row.side === 'sell' ? pairing.sells.get(row.orderId) : null
    if (paired) {
      if (paired.pnl != null) display.bodyPnl = paired.pnl
      display.bodyHoldbackAsset = paired.holdback
      display.bodyReservesSoldAsset = paired.reservesSold
    }
    detail.set(row, display)
  }
  for (const sell of [...orderedSells].reverse()) {
    const sellRows = sellsByOrder.get(sell.orderId) || []
    const linked = (sell.buyKeys.length ? sell.buyKeys : (buyKeysByBody.get(sell.bodyId) || []))
      .flatMap(key => buysByKey.get(key) || [])
    if (detail.size + sellRows.length + linked.length > MAX_DETAIL_FILLS) {
      if (detail.size >= MAX_DETAIL_FILLS) break
      continue
    }
    sellRows.forEach(add)
    linked.forEach(add)
  }
  // Unpaired buys may appear as orphan rows in Filled Orders. The same bounded
  // rows also support the Open Orders relation index and live-core fallback.
  const openFills = []
  let openFillCount = 0
  const liveCycleId = [...cycles.keys()].filter(id => liveCycleNumber(id) >= 0)
    .sort((a, b) => liveCycleNumber(b) - liveCycleNumber(a))[0] || null
  const latestCoreSell = rows.reduce((latest, row) =>
    row.side === 'sell' && !row.isBodyOwned && !row.isSatellite &&
    (!liveCycleId || !row.cycleId || row.cycleId === liveCycleId) && time(row) >= time(latest || {})
      ? row : latest, null)
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.side !== 'buy') continue
    const key = buyPairKey(row)
    if (pairing.buys.get(key)?.pairedSellOrderId) continue
    if (!row.sellOrderId && ((liveCycleId && row.cycleId && row.cycleId !== liveCycleId) || time(row) <= time(latestCoreSell || {}))) continue
    openFillCount++
    if (openFills.length < MAX_OPEN_FILLS) {
      openFills.push(project(row))
      add(row)
    }
  }
  if (latestCoreSell) openFills.push(project(latestCoreSell))
  return {
    fillCount: rows.length, buyCount, sellCount, sellOrderCount: pairing.sells.size,
    cycleCount: sortedCycles.length, cycles: sortedCycles.slice(0, MAX_CYCLES),
    cyclesTruncated: sortedCycles.length > MAX_CYCLES, latestCycleId,
    fillCycleCount: fillCycleGroups.length, fillCycleGroups: fillCycleGroups.slice(0, MAX_CYCLES),
    fillCyclesTruncated: fillCycleGroups.length > MAX_CYCLES,
    totalPnl: pairing.realizedPnL, totalHoldback: pairing.realizedAssetPnL,
    pnlPoints, pnlPointsTruncated: allPoints.length > pnlPoints.length,
    detailFills: [...detail.values()], detailsTruncated: detail.size < rows.length,
    openFills, openFillsTruncated: openFillCount > MAX_OPEN_FILLS,
  }
}
