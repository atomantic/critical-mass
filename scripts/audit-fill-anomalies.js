#!/usr/bin/env node
/**
 * Read-only audit of a pair's fill-ledger.json for buy↔sell linkage anomalies.
 *
 * Categories detected:
 *   1. body_size_mismatch  - sell.size ≠ bodyBtcQty/satelliteBtcQty (wrong body annotation
 *                            or order-quantity drift after merge/roll-up)
 *   2. bodyowned_no_bodyid - sell has isBodyOwned:true but bodyId is missing
 *   3. overlinked_buys     - sum(linkedBuys.size) > expected (body sells: > bodyBtcQty;
 *                            non-body sells: > sell.size + holdback)
 *   4. underlinked_buys    - sum(linkedBuys.size) << expected (sell consumed buys
 *                            that aren't pointing at it)
 *   5. orphan_sell_link    - buy carries sellOrderId that doesn't exist in the ledger
 *   6. cross_body_link     - buy linked to a sell that belongs to a different bodyId
 *                            (often an intentional manual repair; review before fixing)
 *   7. unlinked_completed  - buys in a non-current cycle with no sellOrderId at all
 *
 * Each anomaly carries a severity (high/med/low) and a suggestedAction hint.
 *
 * Usage:
 *   node scripts/audit-fill-anomalies.js [--exchange coinbase] [--pair BTC-USDC]
 *                                        [--out report.json] [--category overlinked_buys]
 *                                        [--limit 20] [--ignore orderId1,orderId2]
 *
 * Exits 0 on success regardless of findings — this is a read-only auditor.
 */

const fs = require('fs')
const path = require('path')
const { resolveFundDataDir } = require('../src/migration')

const args = (() => {
  const out = { exchange: 'coinbase', pair: 'BTC-USDC', out: null, category: null, limit: 0, ignore: new Set() }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exchange') out.exchange = argv[++i]
    else if (a === '--pair') out.pair = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--category') out.category = argv[++i]
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 0
    else if (a === '--ignore') argv[++i].split(',').forEach(id => out.ignore.add(id.trim()))
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/audit-fill-anomalies.js [--exchange X] [--pair Y] [--out f.json] [--category K] [--limit N] [--ignore id1,id2]')
      process.exit(0)
    }
  }
  return out
})()

const dataDir = resolveFundDataDir(args.exchange, args.pair)
const ledgerPath = path.join(dataDir, 'fill-ledger.json')
const closedTradesPath = path.join(dataDir, 'closed-trades.json')
const regimeStatePath = path.join(dataDir, 'regime-state.json')

if (!fs.existsSync(ledgerPath)) {
  console.error(`✗ ledger not found: ${ledgerPath}`)
  process.exit(1)
}

const readJson = (p, label) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    console.error(`✗ failed to parse ${label} (${p}): ${err.message}`)
    process.exit(1)
  }
}

const ledger = readJson(ledgerPath, 'fill-ledger')
const fills = Array.isArray(ledger) ? ledger : (ledger.fills || [])

const closedTrades = fs.existsSync(closedTradesPath) ? readJson(closedTradesPath, 'closed-trades') : []
const closedBySellId = new Map()
for (const t of (Array.isArray(closedTrades) ? closedTrades : (closedTrades.trades || []))) {
  closedBySellId.set(t.sellOrderId, t)
}

let currentCycleId = null
const activeOpenTpIds = new Set()  // TP orderIds of bodies still alive (open on exchange)
if (fs.existsSync(regimeStatePath)) {
  try {
    const rs = JSON.parse(fs.readFileSync(regimeStatePath, 'utf8'))
    currentCycleId = rs.currentCycleId || rs.positionState?.currentCycleId || null
    const bodies = rs.position?.celestialBodies || rs.positionState?.celestialBodies || []
    for (const b of bodies) {
      if (b.tpOrderId) activeOpenTpIds.add(b.tpOrderId)
    }
    if (rs.position?.activeTpOrderId) activeOpenTpIds.add(rs.position.activeTpOrderId)
  } catch { /* ignore */ }
}
// Fallback: regime-state.json doesn't actually persist currentCycleId, so
// derive it. The current cycle is the most recent one that ISN'T fully
// closed — match fill-ledger.js which treats a cycle as active until
// sells fully cover buys (sellRatio < 1.0). A 50% threshold would
// misclassify any cycle that's 50–99% sold as completed and silently
// suppress its unlinked_completed findings.
if (!currentCycleId) {
  const cycleSizes = new Map()  // cycleId -> { buys, sells, latestTs }
  for (const f of fills) {
    if (!f.cycleId) continue
    if (!cycleSizes.has(f.cycleId)) cycleSizes.set(f.cycleId, { buys: 0, sells: 0, latestTs: 0 })
    const c = cycleSizes.get(f.cycleId)
    if (f.side === 'buy') c.buys += Number(f.size || 0)
    else if (f.side === 'sell') c.sells += Number(f.size || 0)
    c.latestTs = Math.max(c.latestTs, f.timestamp || 0)
  }
  const open = [...cycleSizes.entries()]
    .filter(([, c]) => c.buys > 0 && c.sells / c.buys < 1.0)
    .sort((a, b) => b[1].latestTs - a[1].latestTs)
  currentCycleId = open[0]?.[0] || null  // null = no open cycle, all are completed
}

// ── Aggregate by orderId ──────────────────────────────────────────────────────

/** @type {Map<string, {orderId:string, side:string, size:number, value:number, fees:number, fills:any[], price:number}>} */
const orderIndex = new Map()
for (const f of fills) {
  if (!orderIndex.has(f.orderId)) {
    orderIndex.set(f.orderId, {
      orderId: f.orderId,
      side: f.side,
      size: 0,
      value: 0,
      fees: 0,
      fills: [],
      price: 0,
    })
  }
  const o = orderIndex.get(f.orderId)
  o.size += Number(f.size || 0)
  o.value += Number(f.quoteAmount || (f.size * f.price) || 0)
  o.fees += Number(f.netFee || f.fee || 0)
  o.fills.push(f)
}
for (const o of orderIndex.values()) {
  o.price = o.size > 0 ? o.value / o.size : 0
}

const sellOrders = [...orderIndex.values()].filter(o => o.side === 'sell')
const sellIds = new Set(sellOrders.map(o => o.orderId))

// ── Group buys by sellOrderId ─────────────────────────────────────────────────

/** @type {Map<string, {orderId:string, size:number, value:number, ts:number, bodyId:string|null}[]>} */
const buysBySellId = new Map()
for (const o of orderIndex.values()) {
  if (o.side !== 'buy') continue
  // Use first fill's sellOrderId; all fills of an order share the annotation
  const sellOrderId = o.fills.find(f => f.sellOrderId)?.sellOrderId
  if (!sellOrderId) continue
  if (!buysBySellId.has(sellOrderId)) buysBySellId.set(sellOrderId, [])
  buysBySellId.get(sellOrderId).push({
    orderId: o.orderId,
    size: o.size,
    value: o.value,
    ts: Math.min(...o.fills.map(f => f.timestamp || 0)),
    bodyId: o.fills[0].bodyId || null,
  })
}

// ── Anomaly detection ─────────────────────────────────────────────────────────

const anomalies = []
const fmtId = id => (id || '').slice(0, 12)

const push = (a) => { if (!args.ignore.has(a.orderId)) anomalies.push(a) }

for (const sell of sellOrders) {
  const f0 = sell.fills[0]
  const bodyQty = f0.bodyBtcQty != null ? Number(f0.bodyBtcQty) : null
  const satQty = f0.satelliteBtcQty != null ? Number(f0.satelliteBtcQty) : null
  const expectedQty = bodyQty ?? satQty
  const isBody = !!(f0.isBodyOwned || f0.isSatellite)
  const linked = buysBySellId.get(sell.orderId) || []
  const linkedSize = linked.reduce((a, b) => a + b.size, 0)
  const closed = closedBySellId.get(sell.orderId)

  // 1) body_size_mismatch
  if (isBody && expectedQty != null && expectedQty > 0) {
    const diff = Math.abs(sell.size - expectedQty)
    const pct = diff / expectedQty
    if (diff > Math.max(expectedQty * 0.01, 0.0001)) {
      push({
        category: 'body_size_mismatch',
        severity: pct > 0.5 ? 'high' : 'med',
        orderId: sell.orderId,
        sellSize: sell.size,
        expectedQty,
        deltaPct: pct,
        bodyId: f0.bodyId || null,
        ts: f0.timestamp,
        details: `sell.size=${sell.size} but recorded body${satQty != null ? '/satellite' : ''}Qty=${expectedQty}`,
        suggestedAction: 'Inspect: did this sell consume a different (larger/smaller) body? Re-derive bodyBtcQty/avgPrice from the actual sourceOrderIds.',
      })
    }
  }

  // 2) bodyowned_no_bodyid
  if (f0.isBodyOwned && !f0.bodyId) {
    push({
      category: 'bodyowned_no_bodyid',
      severity: 'med',
      orderId: sell.orderId,
      sellSize: sell.size,
      ts: f0.timestamp,
      details: 'isBodyOwned:true but bodyId is missing on sell record',
      suggestedAction: 'Re-annotate from the body that produced this TP (lookup by tpOrderId in regime-state history or repair-script logs).',
    })
  }

  // 3) overlinked_buys
  if (linked.length > 0) {
    let expectForLink = null
    let basis = ''
    if (isBody && expectedQty != null) {
      expectForLink = expectedQty
      basis = `bodyBtcQty=${expectedQty}`
    } else if (closed && closed.qtySold != null) {
      expectForLink = Number(closed.qtySold) + Number(closed.holdbackAsset || 0)
      basis = `qtySold+holdback=${expectForLink}`
    } else {
      // No holdback info — only flag if egregious (linked > 5x sell.size)
      expectForLink = sell.size * 5
      basis = `sell.size×5 fallback (no closed-trade holdback record)`
    }
    if (linkedSize - expectForLink > Math.max(expectForLink * 0.02, 0.0001)) {
      const overlap = linkedSize - expectForLink
      push({
        category: 'overlinked_buys',
        severity: overlap > expectForLink * 0.5 ? 'high' : (overlap > expectForLink * 0.05 ? 'med' : 'low'),
        orderId: sell.orderId,
        sellSize: sell.size,
        linkedSize,
        expectedSize: expectForLink,
        excess: overlap,
        basis,
        linkedBuys: linked.map(b => ({ orderId: b.orderId, size: b.size, bodyId: b.bodyId, ts: b.ts })),
        ts: f0.timestamp,
        details: `${linked.length} buy orders sum to ${linkedSize.toFixed(8)}, expected ≤ ${expectForLink.toFixed(8)} (${basis})`,
        suggestedAction: 'FIFO-walk cycle buys oldest-first; keep linkage only on enough buy quantity to cover (sell.size + holdback). Clear sellOrderId on excess buys.',
      })
    }
  }

  // 4) underlinked_buys
  if (linked.length > 0 && (isBody || closed)) {
    const expect = isBody && expectedQty != null
      ? expectedQty
      : (closed ? Number(closed.qtySold) + Number(closed.holdbackAsset || 0) : null)
    if (expect != null && expect - linkedSize > Math.max(expect * 0.05, 0.0005)) {
      push({
        category: 'underlinked_buys',
        severity: linkedSize < expect * 0.5 ? 'high' : 'med',
        orderId: sell.orderId,
        sellSize: sell.size,
        linkedSize,
        expectedSize: expect,
        shortfall: expect - linkedSize,
        ts: f0.timestamp,
        details: `${linked.length} linked buys sum to ${linkedSize.toFixed(8)}, expected ≈ ${expect.toFixed(8)}`,
        suggestedAction: 'Find buys that should belong to this sell (price/timing match) and set their sellOrderId.',
      })
    }
  } else if (linked.length === 0 && (isBody || closed)) {
    push({
      category: 'underlinked_buys',
      severity: 'high',
      orderId: sell.orderId,
      sellSize: sell.size,
      linkedSize: 0,
      expectedSize: isBody ? expectedQty : (closed ? Number(closed.qtySold) + Number(closed.holdbackAsset || 0) : null),
      ts: f0.timestamp,
      details: 'No buys link to this sell at all',
      suggestedAction: 'Walk cycle buys; identify the source buys for this body/cycle and annotate sellOrderId.',
    })
  }

  // 6) cross_body_link  (note: may be intentional)
  if (f0.bodyId && linked.length > 0) {
    const wrongBody = linked.filter(b => b.bodyId && b.bodyId !== f0.bodyId)
    if (wrongBody.length > 0) {
      push({
        category: 'cross_body_link',
        severity: 'low',
        orderId: sell.orderId,
        sellBodyId: f0.bodyId,
        crossLinkedBuys: wrongBody.map(b => ({ orderId: b.orderId, bodyId: b.bodyId, size: b.size })),
        ts: f0.timestamp,
        details: `${wrongBody.length} linked buys belong to different bodies than the sell`,
        suggestedAction: 'Review — may be an intentional manual repair pairing. If accidental, re-link to the correct body’s sell.',
      })
    }
  }
}

// 5) orphan_sell_link
//   Buys point at a sellOrderId that's not in the ledger. We split into two
//   buckets so a stale persisted tpOrderId (e.g., the engine missed a fill or
//   cancel while offline) doesn't silently hide a real orphan reference:
//     - claimed_by_active_body: still listed as a body's tpOrderId in
//       regime-state.json. Probably an open TP on the exchange, but only
//       persistence proves it — verify against exchange before trusting.
//     - orphan_sell_link: no claim from any body — an unambiguous orphan.
for (const [sellId, linked] of buysBySellId) {
  if (sellIds.has(sellId)) continue
  const linkedSize = linked.reduce((a, b) => a + b.size, 0)
  const claimed = activeOpenTpIds.has(sellId)
  push({
    category: claimed ? 'claimed_by_active_body' : 'orphan_sell_link',
    severity: claimed ? 'low' : (linkedSize > 0.01 ? 'high' : 'med'),
    orderId: sellId,
    linkedSize,
    linkedBuys: linked.map(b => ({ orderId: b.orderId, size: b.size, bodyId: b.bodyId, ts: b.ts })),
    details: claimed
      ? `${linked.length} buys point at ${fmtId(sellId)} — listed as an active body TP in regime-state (verify it's still open on the exchange)`
      : `${linked.length} buys point at sellOrderId ${fmtId(sellId)} which is not in the ledger`,
    suggestedAction: claimed
      ? 'Confirm the order is still OPEN on the exchange. If it filled/cancelled while offline, ingest the fills (or clear the body tpOrderId) so the linkage repairs itself.'
      : 'Clear sellOrderId on these buys (or re-link to the real sell that consumed them).',
  })
}

// 7) unlinked_completed
let unlinkedCount = 0
let unlinkedSize = 0
const unlinkedSamples = []
for (const o of orderIndex.values()) {
  if (o.side !== 'buy') continue
  const f = o.fills[0]
  if (f.cycleId && f.cycleId !== currentCycleId && !f.sellOrderId && !f.isBodyOwned && !f.isSatellite) {
    unlinkedCount++
    unlinkedSize += o.size
    if (unlinkedSamples.length < 10) unlinkedSamples.push({ orderId: o.orderId, size: o.size, cycleId: f.cycleId, ts: f.timestamp })
  }
}
if (unlinkedCount > 0) {
  push({
    category: 'unlinked_completed',
    severity: unlinkedSize > 0.01 ? 'med' : 'low',
    orderId: '(many)',
    count: unlinkedCount,
    totalSize: unlinkedSize,
    samples: unlinkedSamples,
    details: `${unlinkedCount} buys in completed cycles have no sellOrderId (totalling ${unlinkedSize.toFixed(8)})`,
    suggestedAction: 'These cycles closed without per-buy linkage; backfill via chronological FIFO or accept as legacy gap.',
  })
}

// ── Reporting ─────────────────────────────────────────────────────────────────

const filtered = args.category ? anomalies.filter(a => a.category === args.category) : anomalies

const byCategory = {}
for (const a of anomalies) {
  if (!byCategory[a.category]) byCategory[a.category] = { high: 0, med: 0, low: 0, total: 0 }
  byCategory[a.category][a.severity] += 1
  byCategory[a.category].total += 1
}

console.log(`\n=== Fill-ledger audit: ${args.exchange} / ${args.pair} ===`)
console.log(`Ledger fills: ${fills.length} | sell orders: ${sellOrders.length} | linked sellIds: ${buysBySellId.size}`)
console.log(`Current cycle: ${currentCycleId || '(unknown)'}`)
if (args.ignore.size > 0) console.log(`Ignoring ${args.ignore.size} orderId(s)`)
console.log()
console.log('Findings by category:')
for (const cat of Object.keys(byCategory).sort()) {
  const c = byCategory[cat]
  console.log(`  ${cat.padEnd(22)} total=${String(c.total).padStart(4)}  high=${String(c.high).padStart(3)}  med=${String(c.med).padStart(3)}  low=${String(c.low).padStart(3)}`)
}
console.log(`  ${'TOTAL'.padEnd(22)} total=${String(anomalies.length).padStart(4)}\n`)

// Print top-N per shown category
const sortedSev = { high: 3, med: 2, low: 1 }
const printable = filtered
  .slice()
  .sort((a, b) => (sortedSev[b.severity] - sortedSev[a.severity]) || (Math.abs(b.excess || b.shortfall || b.deltaPct || 0) - Math.abs(a.excess || a.shortfall || a.deltaPct || 0)))

const limit = args.limit > 0 ? args.limit : (args.category ? 50 : 20)
console.log(`Showing top ${Math.min(limit, printable.length)} of ${printable.length}${args.category ? ` (category=${args.category})` : ''}:\n`)
for (const a of printable.slice(0, limit)) {
  const tag = `[${a.severity.toUpperCase()}] ${a.category}`
  console.log(`${tag}  sell=${fmtId(a.orderId)}  ${a.details}`)
  if (a.linkedBuys && a.linkedBuys.length <= 6) {
    for (const b of a.linkedBuys) {
      console.log(`     · buy ${fmtId(b.orderId)}  size=${b.size?.toFixed(8) ?? '?'}${b.bodyId ? `  body=${b.bodyId.slice(-8)}` : ''}`)
    }
  } else if (a.linkedBuys) {
    console.log(`     · ${a.linkedBuys.length} linked buys (run with --out to see all)`)
  }
  if (a.suggestedAction) console.log(`     → ${a.suggestedAction}`)
  console.log()
}

if (args.out) {
  const report = {
    meta: {
      exchange: args.exchange,
      pair: args.pair,
      generatedAt: new Date().toISOString(),
      ledgerFills: fills.length,
      sellOrders: sellOrders.length,
      currentCycleId,
    },
    summary: byCategory,
    anomalies: filtered,
  }
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2))
  const filterNote = args.category ? ` (${args.category}, ${anomalies.length} total in ledger)` : ''
  console.log(`📄 Full report written: ${args.out}  (${filtered.length} anomalies${filterNote})`)
}
