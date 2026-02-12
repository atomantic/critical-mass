#!/usr/bin/env node
/**
 * One-time repair script: Fix sellOrderId annotations in the fill ledger.
 *
 * Issues found via price-based matching of body sells to source buys:
 *   - 5 mismapped   (sellOrderId points to wrong sell)
 *   - 3 unmapped     (no sellOrderId at all)
 *   - 1 multi-buy body (12 buys pointing to stale legacy TP 3b5737ff)
 *   - 1 orphan        (buy after sell with stale sellOrderId)
 */

const { readFileSync, writeFileSync, copyFileSync } = require('fs')
const { resolve } = require('path')

const ledgerPath = resolve(__dirname, '../data/coinbase/fill-ledger.json')
const fills = JSON.parse(readFileSync(ledgerPath, 'utf8'))

// Index by orderId for quick lookup (multiple fills per orderId possible)
const fillsByOrderId = new Map()
for (const fill of fills) {
  if (!fillsByOrderId.has(fill.orderId)) fillsByOrderId.set(fill.orderId, [])
  fillsByOrderId.get(fill.orderId).push(fill)
}

let changes = 0

// All body sells in current cycle
const CYCLE = 'cycle-1770195737025-k9ae9wd2v'
const cycleSells = fills.filter(f => f.side === 'sell' && (f.isBodyOwned || f.isSatellite) && f.cycleId === CYCLE)
const cycleBuys = fills.filter(f => f.side === 'buy' && f.cycleId === CYCLE)

console.log(`📊 Found ${cycleSells.length} body sells, ${cycleBuys.length} buys in current cycle\n`)

// --- 1) Single-buy body sells: match by bodyAvgPrice to buy price ---
// bodyAvgPrice records the source buy's exact price for single-buy bodies
const PRICE_TOLERANCE = 0.02

for (const sell of cycleSells) {
  const sellAvgPrice = sell.bodyAvgPrice ?? sell.satelliteAvgPrice
  const sellBtcQty = sell.bodyBtcQty ?? sell.satelliteBtcQty
  if (!sellAvgPrice || !sellBtcQty) continue

  const matchingBuys = cycleBuys.filter(buy =>
    Math.abs(buy.price - sellAvgPrice) < PRICE_TOLERANCE
  )

  if (matchingBuys.length === 1) {
    const buy = matchingBuys[0]
    const allFillsForBuy = fillsByOrderId.get(buy.orderId) || []
    const currentSellId = allFillsForBuy[0] && allFillsForBuy[0].sellOrderId

    if (currentSellId === sell.orderId) {
      console.log(`✅ ${sell.orderId.slice(0, 8)} <- ${buy.orderId.slice(0, 8)} [already correct]`)
    } else {
      const label = currentSellId ? `remap from ${currentSellId.slice(0, 8)}` : 'was unmapped'
      console.log(`🔧 ${sell.orderId.slice(0, 8)} <- ${buy.orderId.slice(0, 8)} [${label}]`)
      for (const f of allFillsForBuy) {
        f.sellOrderId = sell.orderId
        f.isBodyOwned = true
        if (sell.bodyId && !f.bodyId) {
          f.bodyId = sell.bodyId
          f.bodyTier = sell.bodyTier
        }
        changes++
      }
    }

    // Clear any OTHER buys that were incorrectly linked to this sell
    const wrongBuys = fills.filter(f =>
      f.side === 'buy' &&
      f.sellOrderId === sell.orderId &&
      f.orderId !== buy.orderId
    )
    for (const wb of wrongBuys) {
      console.log(`🧹 ${sell.orderId.slice(0, 8)}: clearing wrong link from ${wb.orderId.slice(0, 8)} (price ${wb.price})`)
      delete wb.sellOrderId
      changes++
    }
  } else if (matchingBuys.length === 0) {
    console.log(`🔶 ${sell.orderId.slice(0, 8)} — no single price match (multi-buy body, avgPrice=${sellAvgPrice})`)
  } else {
    console.log(`⚠️  ${sell.orderId.slice(0, 8)} — ${matchingBuys.length} price matches for ${sellAvgPrice}, skipping`)
  }
}

// --- 2) Multi-buy body: da726af9 (body-ba245864-mlf4r8dr) ---
// All buys with sellOrderId "3b5737ff..." placed BEFORE the da726af9 sell
const STALE_TP = '3b5737ff-54af-4291-93b8-7fa200f73c61'
const DA726AF9_SELL = 'da726af9-dab9-4310-96fb-d2cc82d22be6'
const DA726AF9_BODY = 'body-ba245864-mlf4r8dr'

const da726Sell = fills.find(f => f.orderId === DA726AF9_SELL && f.side === 'sell')
if (da726Sell) {
  const staleBuys = fills.filter(f =>
    f.side === 'buy' &&
    f.sellOrderId === STALE_TP &&
    f.timestamp < da726Sell.timestamp
  )

  const totalBtc = staleBuys.reduce((sum, b) => sum + b.size, 0)
  const da726BtcQty = da726Sell.bodyBtcQty ?? da726Sell.satelliteBtcQty
  console.log(`\n🔧 da726af9 multi-buy body: ${staleBuys.length} buys, ${totalBtc.toFixed(8)} BTC (expected ${da726BtcQty})`)

  if (Math.abs(totalBtc - da726BtcQty) < 0.00000002) {
    for (const buy of staleBuys) {
      buy.sellOrderId = DA726AF9_SELL
      buy.isBodyOwned = true
      if (!buy.bodyId) {
        buy.bodyId = DA726AF9_BODY
        buy.bodyTier = 'planet'
      }
      changes++
    }
    console.log(`   ✅ Remapped ${staleBuys.length} fills to da726af9, added bodyId where missing`)
  } else {
    console.log(`   ⚠️  BTC sum mismatch: ${totalBtc} vs ${da726BtcQty}, skipping`)
  }
}

// --- 3) Orphan cleanup: remaining buys with stale 3b5737ff ---
const remainingStale = fills.filter(f =>
  f.side === 'buy' &&
  f.sellOrderId === STALE_TP
)

if (remainingStale.length > 0) {
  console.log(`\n🧹 Clearing ${remainingStale.length} remaining stale 3b5737ff references:`)
  for (const buy of remainingStale) {
    console.log(`   ${buy.orderId.slice(0, 8)} @ $${buy.price} (${buy.size} BTC, ts=${buy.timestamp})`)
    delete buy.sellOrderId
    changes++
  }
}

// --- Summary and save ---
console.log(`\n📝 Total changes: ${changes}`)

if (changes > 0) {
  const backupPath = ledgerPath + '.backup-' + Date.now()
  copyFileSync(ledgerPath, backupPath)
  console.log(`💾 Backup saved to ${backupPath}`)

  writeFileSync(ledgerPath, JSON.stringify(fills, null, 2) + '\n')
  console.log(`✅ Fill ledger updated successfully`)
} else {
  console.log('ℹ️  No changes needed')
}
