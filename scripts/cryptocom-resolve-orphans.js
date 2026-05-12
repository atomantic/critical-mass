#!/usr/bin/env node
/**
 * Resolve orphan buys and sells via metadata-only re-attribution.
 *
 * Two-pass strategy:
 *
 *   PASS 1 — Orphan sells: walk orphan sells chronologically; for each, take
 *   FIFO buys from the black_hole TP group (sellOrderId=BLACK_HOLE_TP) that
 *   are timestamped before the sell, until cumulative qty matches sell qty.
 *   Reassign those buys' sellOrderId to the orphan sell's orderId and clear
 *   their bodyId (they no longer "belong" to the black_hole). Clear the sell's
 *   untrackedSell flag.
 *
 *   The math holds because the black_hole TP filled 483,593 CRO against
 *   514,034 CRO of linked buys (30,441 CRO excess); reassigning ~8,065 CRO
 *   of buys to orphan sells still leaves the black_hole with positive cover.
 *   FIFO time-ordering matches what "really" happened: the older buys were
 *   the lots consumed by these earlier orphan sells.
 *
 *   PASS 2 — Orphan buys: the 5 cycle-10 buys from 2026-05-11/12 (placed
 *   between the rectified cycle-10 TPs filling and the cycle-11 bodies
 *   forming). Merge them into the nebula body — set bodyId/bodyTier/
 *   sellOrderId on the buys, append to body.buyOrders, recompute body
 *   assetQty/costBasis/avgPrice. Engine will detect the qty mismatch with
 *   the on-exchange TP on next tick and cancel-replace.
 *
 * Engine MUST be stopped: pm2 stop critical-mass-cryptocom
 *
 * Usage:
 *   node scripts/cryptocom-resolve-orphans.js           # dry-run
 *   node scripts/cryptocom-resolve-orphans.js --apply   # writes
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD');
const LEDGER_PATH = path.join(DIR, 'fill-ledger.json');
const STATE_PATH = path.join(DIR, 'regime-state.json');
const APPLY = process.argv.includes('--apply');

const BLACK_HOLE_TP = '6142909974300226432';
const BLACK_HOLE_BODY_ID = 'body-85084389-mmtxp76q';

const round8 = (n) => Math.round(n * 1e8) / 1e8;
const round2 = (n) => Math.round(n * 100) / 100;

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

const nebula = state.position.celestialBodies.find(b => b.tier === 'nebula');
if (!nebula) {
  console.error('ERROR: nebula body not found — cannot merge orphan buys.');
  process.exit(1);
}
console.log(`Target body for orphan-buy merge: ${nebula.id} (${nebula.tier})`);
console.log(`  current qty=${nebula.assetQty}, avgPrice=$${nebula.avgPrice}, tp=${nebula.tpOrderId}\n`);

// ── PASS 1: orphan sells ────────────────────────────────────────────────────
const orphanSells = ledger.filter(f => f.side === 'sell' && f.untrackedSell);
const orphanSellOrderIds = [...new Set(orphanSells.map(s => String(s.orderId)))];
console.log(`PASS 1 — ${orphanSellOrderIds.length} orphan sell orders:`);

const sellOrderInfo = orphanSellOrderIds.map(oid => {
  const fills = ledger.filter(f => f.side === 'sell' && String(f.orderId) === oid);
  const ts = Math.min(...fills.map(f => f.timestamp));
  const qty = fills.reduce((s, f) => s + f.size, 0);
  return { oid, ts, qty, fills };
}).sort((a, b) => a.ts - b.ts);

// Buys available to reassign: linked to black_hole TP
const availableBuys = ledger
  .filter(f => f.side === 'buy' && String(f.sellOrderId) === BLACK_HOLE_TP)
  .sort((a, b) => a.timestamp - b.timestamp);
console.log(`  available pool: ${availableBuys.length} buys totaling ${availableBuys.reduce((s,f)=>s+f.size,0).toFixed(0)} CRO (linked to black_hole TP)`);

let reassignedCount = 0;
let reassignedQty = 0;
const consumedSet = new Set();
for (const info of sellOrderInfo) {
  let remaining = info.qty;
  let usedHere = 0;
  let countHere = 0;
  for (const buy of availableBuys) {
    if (consumedSet.has(buy.tradeId)) continue;
    if (buy.timestamp >= info.ts) break;  // stop — buy is after the sell
    buy.sellOrderId = info.oid;
    delete buy.bodyId;
    delete buy.bodyTier;
    delete buy.isBodyOwned;
    consumedSet.add(buy.tradeId);
    usedHere += buy.size;
    countHere++;
    reassignedCount++;
    reassignedQty += buy.size;
    remaining -= buy.size;
    if (remaining <= 0) break;
  }
  // Clear the orphan sell's untrackedSell flag if we covered it
  if (countHere > 0) {
    for (const sf of info.fills) delete sf.untrackedSell;
  }
  console.log(`  sell ${info.oid} (${new Date(info.ts).toISOString()}) needed ${info.qty.toFixed(0)} CRO → assigned ${countHere} buys (${usedHere.toFixed(0)} CRO)${remaining > 0 ? ` ⚠ short by ${remaining.toFixed(0)}` : ''}`);
}
console.log(`  TOTAL: ${reassignedCount} buys (${reassignedQty.toFixed(0)} CRO) reassigned from black_hole TP to orphan sells\n`);

// ── PASS 2: orphan buys ─────────────────────────────────────────────────────
const orphanBuys = ledger
  .filter(f => f.side === 'buy' && !f.sellOrderId)
  .sort((a, b) => a.timestamp - b.timestamp);

console.log(`PASS 2 — ${orphanBuys.length} orphan buys (no sellOrderId):`);
const mergedQtys = [];
for (const buy of orphanBuys) {
  buy.sellOrderId = nebula.tpOrderId;
  buy.bodyId = nebula.id;
  buy.bodyTier = nebula.tier;
  buy.isBodyOwned = true;
  // Don't change cycleId; engine's recalculateCycles will reassign on restart
  mergedQtys.push(buy.size);
  console.log(`  ${new Date(buy.timestamp).toISOString()} oid=${buy.orderId} qty=${buy.size} → merged into nebula`);
}
const orphanBuyQty = mergedQtys.reduce((s, q) => s + q, 0);
const orphanBuyCost = orphanBuys.reduce((s, f) => s + (f.quoteAmount || 0) + (f.netFee || 0), 0);
console.log(`  TOTAL: ${orphanBuys.length} buys / ${orphanBuyQty.toFixed(0)} CRO / $${orphanBuyCost.toFixed(2)} merged into nebula\n`);

// Update nebula body
const newNebulaQty = round8(nebula.assetQty + orphanBuyQty);
const newNebulaCost = round2(nebula.costBasis + orphanBuyCost);
const newNebulaAvg = round8(newNebulaCost / newNebulaQty);

// Append buyOrders for the merged buys (use one entry per orderId, summing fills)
const existingBuyOrderIds = new Set(nebula.buyOrders.map(b => String(b.orderId)));
const buyOrdersByOid = new Map();
for (const buy of orphanBuys) {
  const oid = String(buy.orderId);
  if (existingBuyOrderIds.has(oid)) continue;
  const prev = buyOrdersByOid.get(oid);
  if (prev) {
    prev.assetQty += buy.size;
    prev.quoteAmount += (buy.quoteAmount || 0);
  } else {
    buyOrdersByOid.set(oid, {
      orderId: oid,
      assetQty: buy.size,
      price: buy.price,
      quoteAmount: buy.quoteAmount || 0,
      timestamp: buy.timestamp,
    });
  }
}

console.log(`Nebula body changes:`);
console.log(`  assetQty:  ${nebula.assetQty} → ${newNebulaQty}`);
console.log(`  costBasis: $${nebula.costBasis} → $${newNebulaCost}`);
console.log(`  avgPrice:  $${nebula.avgPrice.toFixed(6)} → $${newNebulaAvg.toFixed(6)}`);
console.log(`  buyOrders: ${nebula.buyOrders.length} → ${nebula.buyOrders.length + buyOrdersByOid.size}`);

if (!APPLY) {
  console.log(`\nDry-run — pass --apply to write.`);
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
const bpLedger = `${LEDGER_PATH}.backup-orphan-${Date.now()}`;
const bpState = `${STATE_PATH}.backup-orphan-${Date.now()}`;
fs.copyFileSync(LEDGER_PATH, bpLedger);
fs.copyFileSync(STATE_PATH, bpState);
console.log(`\n💾 Backups: ${path.basename(bpLedger)}, ${path.basename(bpState)}`);

// Update nebula body in state
nebula.assetQty = newNebulaQty;
nebula.costBasis = newNebulaCost;
nebula.avgPrice = newNebulaAvg;
for (const bo of buyOrdersByOid.values()) nebula.buyOrders.push(bo);
nebula.lastMergedAt = Date.now();
state.position.totalAsset = round8(state.position.celestialBodies.reduce((s,b)=>s+b.assetQty,0));
state.position.totalCostBasis = round2(state.position.celestialBodies.reduce((s,b)=>s+b.costBasis,0));
state.position.avgCostBasis = state.position.totalAsset > 0
  ? round8(state.position.totalCostBasis / state.position.totalAsset)
  : 0;

fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
console.log(`✅ Wrote ${path.basename(LEDGER_PATH)} and ${path.basename(STATE_PATH)}`);
console.log(`\nEngine will replace nebula TP on next tick (body qty > TP qty).`);
