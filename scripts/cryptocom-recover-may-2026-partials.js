#!/usr/bin/env node
/**
 * Recover Crypto.com CRO_USD orphan partial fills (May 2026) by merging them
 * into the existing celestial body.
 *
 * Context: `src/adapters/cryptocom/api.js` getOrderFills used to call
 * `private/get-trades` with no params, which returns at most ~100 recent
 * trades. When later partial fills of an order happened after >100 other
 * trades had occurred, the polling backstop's "delta partial" path ingested
 * nothing — orphaning those fills. 32 fills (28,195 CRO / ~$2,189) on 14
 * orderIds from May 12–15 leaked this way (most are "partial-known": earlier
 * fills landed but later partials of the same order didn't).
 *
 * The adapter fix (windowed, instrument-scoped get-trades + halving) ships in
 * the same change set. This script recovers the lost fills:
 *   1. Ingests missing-fills.json into fill-ledger.json with bodyId, bodyTier,
 *      sellOrderId, cycleId set to the existing body.
 *   2. Bumps the body's assetQty / costBasis / avgPrice and updates per-order
 *      entries in body.buyOrders (creating new ones for fully-orphan orderIds,
 *      growing existing entries for partial-known ones).
 *   3. Updates position totals to match.
 *
 * Does NOT touch the on-exchange TP order. The engine's reconcile loop sees
 * the body.assetQty > body.assetOnOrder mismatch on the next tick and
 * cancel-replaces the TP at the correct (larger) size.
 *
 * Prereq:  node scripts/fetch-cryptocom-trades.js
 *          node scripts/diff-cryptocom-ledger.js   # writes missing-fills.json
 *
 * Engine MUST be stopped: pm2 stop critical-mass-cryptocom
 * Refuses to run if state file was touched in the last 15 seconds.
 *
 * Usage:
 *   node scripts/cryptocom-recover-may-2026-partials.js          # dry-run
 *   node scripts/cryptocom-recover-may-2026-partials.js --apply  # writes
 */
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DIR = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD');
const stateFile = path.join(DIR, 'regime-state.json');
const ledgerFile = path.join(DIR, 'fill-ledger.json');
const missingFile = path.join(DIR, 'missing-fills.json');

if (!fs.existsSync(missingFile)) {
  console.error(`⛔ ${missingFile} not found. Run scripts/diff-cryptocom-ledger.js first.`);
  process.exit(1);
}

const stateAge = (Date.now() - fs.statSync(stateFile).mtimeMs) / 1000;
if (APPLY && stateAge < 15) {
  console.error(`⛔ regime-state.json was modified ${stateAge.toFixed(0)}s ago — engine likely running.`);
  console.error('   Stop it first: pm2 stop critical-mass-cryptocom');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
const missing = JSON.parse(fs.readFileSync(missingFile, 'utf8'));

if (missing.length === 0) {
  console.log('✅ missing-fills.json is empty — nothing to recover.');
  process.exit(0);
}

const bodies = state.position?.celestialBodies || [];
if (bodies.length !== 1) {
  console.error(`⛔ expected exactly 1 celestial body, found ${bodies.length}. Aborting.`);
  console.error('   (this script assumes the single-body shape of the live CRO state on 2026-05-17)');
  process.exit(1);
}
const body = bodies[0];

// Determine cycleId — use the body's most-recent ledger fill (its current cycle).
const bodyFills = ledger.filter(f => f.bodyId === body.id);
const bodyCycleIds = [...new Set(bodyFills.map(f => f.cycleId).filter(Boolean))];
const cycleNum = (cid) => parseInt(String(cid).split('-').pop(), 10) || 0;
const currentCycle = bodyCycleIds.sort((a, b) => cycleNum(b) - cycleNum(a))[0];
if (!currentCycle) {
  console.error('⛔ Could not determine current cycleId from body fills. Aborting.');
  process.exit(1);
}

// Sanity: only recover buys (no missing sells in this incident)
const sells = missing.filter(t => t.side !== 'BUY');
if (sells.length > 0) {
  console.error(`⛔ ${sells.length} missing SELLs in missing-fills.json — this recipe handles buys only. Aborting.`);
  process.exit(1);
}

const ts = Date.now();

// Group missing fills by orderId
const byOrder = new Map();
for (const t of missing) {
  const oid = String(t.order_id);
  if (!byOrder.has(oid)) byOrder.set(oid, []);
  byOrder.get(oid).push(t);
}

// Sort orderIds by oldest fill time
const orderEntries = [...byOrder.entries()].sort((a, b) => {
  const aMin = Math.min(...a[1].map(t => +t.create_time));
  const bMin = Math.min(...b[1].map(t => +t.create_time));
  return aMin - bMin;
});

const newLedgerRows = [];
const initialSourceCount = (body.sourceOrderIds || []).length;
const sourceOrderIdSet = new Set((body.sourceOrderIds || []).map(String));
const buyOrderByOid = new Map();
for (const bo of (body.buyOrders || [])) buyOrderByOid.set(String(bo.orderId), bo);

let addQty = 0;
let addCost = 0;
let addFees = 0;

console.log(`\nCurrent body: ${body.id}  tier=${body.tier}`);
console.log(`  assetQty=${body.assetQty}  costBasis=$${body.costBasis.toFixed(2)}  avgPrice=$${body.avgPrice.toFixed(5)}`);
console.log(`  tpOrderId=${body.tpOrderId}  tpPrice=$${body.tpPrice}  assetOnOrder=${body.assetOnOrder}`);
console.log(`  current cycleId (from ledger): ${currentCycle}\n`);

console.log(`Processing ${missing.length} missing fills across ${orderEntries.length} orderIds:\n`);

for (const [oid, fills] of orderEntries) {
  const totSize = fills.reduce((s, f) => s + Number(f.traded_quantity), 0);
  const totUsd = fills.reduce((s, f) => s + Number(f.traded_quantity) * Number(f.traded_price), 0);
  const totFee = fills.reduce((s, f) => s + Number(f.fees || 0), 0);
  const avgPrice = totSize > 0 ? totUsd / totSize : 0;
  const firstFillAt = Math.min(...fills.map(f => +f.create_time));
  const lastFillAt = Math.max(...fills.map(f => +f.create_time));

  addQty += totSize;
  addCost += totUsd + totFee;
  addFees += totFee;

  const wasInBody = sourceOrderIdSet.has(oid) || buyOrderByOid.has(oid);

  for (const f of fills) {
    const price = Number(f.traded_price);
    const size = Number(f.traded_quantity);
    const fee = Number(f.fees || 0);
    newLedgerRows.push({
      tradeId: String(f.trade_id),
      orderId: oid,
      side: 'buy',
      price,
      size,
      quoteAmount: price * size,
      fee,
      feeAsset: f.fee_instrument_name || 'CRO',
      rebate: 0,
      netFee: fee,
      liquidityIndicator: (f.taker_side || 'TAKER').toUpperCase(),
      timestamp: Number(f.create_time),
      ingestedAt: ts,
      cycleId: currentCycle,
      orderPlacedAt: null,
      fillTimeMs: null,
      sellOrderId: body.tpOrderId,
      bodyId: body.id,
      bodyTier: body.tier,
      isBodyOwned: true,
    });
  }

  if (wasInBody) {
    // Grow the existing buyOrders entry (if present) so per-order size reflects all partials.
    const bo = buyOrderByOid.get(oid);
    if (bo) {
      const beforeQty = bo.assetQty || 0;
      const beforeCost = bo.sizeUsdc || 0;
      bo.assetQty = Math.round((beforeQty + totSize) * 1e8) / 1e8;
      bo.sizeUsdc = Math.round((beforeCost + totUsd + totFee) * 100) / 100;
      bo.price = bo.assetQty > 0 ? bo.sizeUsdc / bo.assetQty : bo.price;
      bo.filledAt = Math.max(bo.filledAt || 0, lastFillAt);
    } else if (!buyOrderByOid.has(oid)) {
      // orderId is in sourceOrderIds but not in buyOrders (rare) — append.
      body.buyOrders = body.buyOrders || [];
      const newBo = {
        orderId: oid,
        price: avgPrice,
        assetQty: Math.round(totSize * 1e8) / 1e8,
        sizeUsdc: Math.round((totUsd + totFee) * 100) / 100,
        filledAt: lastFillAt,
      };
      body.buyOrders.push(newBo);
      buyOrderByOid.set(oid, newBo);
    }
    console.log(`  [partial-known] ${oid}: +${fills.length} fills, +${totSize} CRO @ $${avgPrice.toFixed(5)} = +$${(totUsd+totFee).toFixed(2)}  ${new Date(firstFillAt).toISOString()}`);
  } else {
    // Fully orphan — add as a new buyOrders entry + sourceOrderIds entry
    body.buyOrders = body.buyOrders || [];
    body.sourceOrderIds = body.sourceOrderIds || [];
    const newBo = {
      orderId: oid,
      price: avgPrice,
      assetQty: Math.round(totSize * 1e8) / 1e8,
      sizeUsdc: Math.round((totUsd + totFee) * 100) / 100,
      filledAt: lastFillAt,
    };
    body.buyOrders.push(newBo);
    body.sourceOrderIds.push(oid);
    buyOrderByOid.set(oid, newBo);
    sourceOrderIdSet.add(oid);
    console.log(`  [fully-orphan ] ${oid}: +${fills.length} fills, +${totSize} CRO @ $${avgPrice.toFixed(5)} = +$${(totUsd+totFee).toFixed(2)}  ${new Date(firstFillAt).toISOString()}`);
  }
}

// Body totals
const beforeQty = body.assetQty;
const beforeCost = body.costBasis;
const beforeAvg = body.avgPrice;
body.assetQty = Math.round((body.assetQty + addQty) * 1e8) / 1e8;
body.costBasis = Math.round((body.costBasis + addCost) * 100) / 100;
body.avgPrice = body.assetQty > 0 ? body.costBasis / body.assetQty : 0;
body.lastMergedAt = ts;
body.mergeCount = (body.mergeCount || 0) + orderEntries.length;

// Position totals (the body is the only one)
const beforeTotalAsset = state.position.totalAsset;
const beforeTotalCost = state.position.totalCostBasis;
state.position.totalAsset = Math.round((state.position.totalAsset + addQty) * 1e8) / 1e8;
state.position.totalCostBasis = Math.round((state.position.totalCostBasis + addCost) * 100) / 100;
state.position.avgCostBasis = state.position.totalAsset > 0
  ? state.position.totalCostBasis / state.position.totalAsset
  : 0;
state.position.cycleBuys = (state.position.cycleBuys || 0) + missing.length;

console.log('\n--- proposed body delta ---');
console.log(`  assetQty   ${beforeQty} -> ${body.assetQty}  (+${addQty})`);
console.log(`  costBasis  $${beforeCost.toFixed(2)} -> $${body.costBasis.toFixed(2)}  (+$${addCost.toFixed(2)})`);
console.log(`  avgPrice   $${beforeAvg.toFixed(5)} -> $${body.avgPrice.toFixed(5)}`);
console.log(`  sourceOrderIds: ${initialSourceCount} -> ${body.sourceOrderIds.length}  (+${body.sourceOrderIds.length - initialSourceCount})`);
console.log(`  buyOrders entries: ${(body.buyOrders || []).length}`);

console.log('\n--- proposed position delta ---');
console.log(`  totalAsset      ${beforeTotalAsset} -> ${state.position.totalAsset}`);
console.log(`  totalCostBasis  $${beforeTotalCost.toFixed(2)} -> $${state.position.totalCostBasis.toFixed(2)}`);
console.log(`  avgCostBasis    $${(beforeTotalCost/beforeTotalAsset).toFixed(5)} -> $${state.position.avgCostBasis.toFixed(5)}`);
console.log(`  cycleBuys       (was ${state.position.cycleBuys - missing.length}) -> ${state.position.cycleBuys}`);

console.log('\n--- ledger delta ---');
console.log(`  +${newLedgerRows.length} buy fills appended`);
console.log(`  ledger size: ${ledger.length} -> ${ledger.length + newLedgerRows.length}`);

console.log('\n--- sanity check vs exchange ---');
console.log(`  reported exchange balance (user): 349,233.7344 CRO`);
console.log(`  new tracked total: body.assetQty + realizedAssetPnL_actual_TBD`);
console.log(`  body.assetQty after recovery: ${body.assetQty} CRO`);
console.log(`  (gap from exchange will be reserves from prior sells — not in this recovery's scope)`);

if (!APPLY) {
  console.log('\nDRY RUN. Pass --apply to write changes.');
  console.log('Reminder: stop engine first → pm2 stop critical-mass-cryptocom');
  process.exit(0);
}

// Backup
fs.copyFileSync(stateFile, `${stateFile}.bak.${ts}`);
fs.copyFileSync(ledgerFile, `${ledgerFile}.bak.${ts}`);
console.log(`\n📁 Backups written:`);
console.log(`   ${stateFile}.bak.${ts}`);
console.log(`   ${ledgerFile}.bak.${ts}`);

// Append new ledger rows (sorted by timestamp, after the existing rows)
newLedgerRows.sort((a, b) => a.timestamp - b.timestamp);
const newLedger = [...ledger, ...newLedgerRows];

const writeAtomic = (filePath, data) => {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
};

writeAtomic(ledgerFile, newLedger);
writeAtomic(stateFile, state);

console.log(`\n✅ Wrote ledger (${newLedger.length} fills) and state.`);
console.log(`Next: pm2 start critical-mass-cryptocom`);
console.log(`The engine's reconcile loop will detect body.assetQty (${body.assetQty}) > body.assetOnOrder (${body.assetOnOrder})`);
console.log(`and cancel-replace TP order ${body.tpOrderId} at the new size.`);
