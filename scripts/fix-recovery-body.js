#!/usr/bin/env node
/**
 * Fix recovery body: replace fake orderId with real buy order IDs.
 *
 * The engine's startup recovery created body-20218508-mli4mxe4 with a
 * synthetic "recovery-1770820218508" orderId. This script:
 *   1. Finds cycle-11 buy fills with no bodyId (truly untracked fills)
 *   2. Maps those as the recovery body's real sourceOrderIds/buyOrders
 *   3. Keeps btcQty/costBasis/avgPrice from the exchange-derived values
 *      (the body includes holdback BTC from 28+ completed bodies that
 *       can't be decomposed into individual fills)
 *   4. Annotates those fills in the ledger with bodyId
 *   5. Annotates ec8b7bcb sell with body metadata to fix dashboard P&L
 *   6. Also cancels the TP order since the avgPrice was wrong
 *      (engine will re-place on startup)
 *
 * Usage: node scripts/fix-recovery-body.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { roundBTC, roundUSDC } = require('../src/volatility-utils');

const LEDGER_PATH = path.join(__dirname, '../data/coinbase/fill-ledger.json');
const STATE_PATH = path.join(__dirname, '../data/coinbase/regime-state.json');
const DRY_RUN = process.argv.includes('--dry-run');

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const pos = state.position;
const bodies = pos.celestialBodies || [];

const RECOVERY_BODY_ID = 'body-20218508-mli4mxe4';
const EC8B_ORDER_ID = 'ec8b7bcb-325a-4bad-a38e-3f76762e3494';

console.log('\n═══════════════════════════════════════════════════');
console.log('  FIX RECOVERY BODY — Map real order IDs');
console.log('═══════════════════════════════════════════════════\n');
if (DRY_RUN) console.log('  *** DRY RUN — no files will be modified ***\n');

// ── Step 1: Find recovery body ──
const recoveryBody = bodies.find(b => b.id === RECOVERY_BODY_ID);
if (!recoveryBody) {
  console.error(`❌ Recovery body ${RECOVERY_BODY_ID} not found in state`);
  process.exit(1);
}

console.log(`📋 Recovery body: ${recoveryBody.btcQty} BTC, costBasis=$${recoveryBody.costBasis}, avgPrice=$${roundUSDC(recoveryBody.avgPrice)}`);
console.log(`   TP order: ${recoveryBody.tpOrderId} @ $${recoveryBody.tpPrice}`);
console.log(`   Current sourceOrderIds: [${recoveryBody.sourceOrderIds.join(', ')}]`);

// ── Step 2: Collect owned order IDs from all non-recovery bodies ──
const ownedOrderIds = new Set();
for (const body of bodies) {
  if (body.id === RECOVERY_BODY_ID) continue;
  for (const srcId of (body.sourceOrderIds || [])) {
    if (srcId !== 'core-migration') ownedOrderIds.add(srcId);
  }
  for (const bo of (body.buyOrders || [])) {
    if (bo.orderId !== 'core-migration') ownedOrderIds.add(bo.orderId);
  }
}

// ── Step 3: Find truly un-bodied cycle-11 buy fills (no bodyId at all) ──
const sunBody = bodies.find(b => b.id === 'body-igration-mlen9yxy');
const migrationTime = sunBody ? sunBody.createdAt : 0;

const unbodiedBuys = ledger.filter(f =>
  f.side === 'buy' &&
  f.cycleId === 'cycle-11' &&
  !ownedOrderIds.has(f.orderId) &&
  f.timestamp > migrationTime &&
  !f.bodyId
);

// Aggregate by orderId (partial fills)
const byOrderId = new Map();
for (const f of unbodiedBuys) {
  const ex = byOrderId.get(f.orderId);
  if (ex) {
    ex.btcQty += f.size;
    ex.sizeUsdc += (f.quoteAmount || f.price * f.size) + (f.netFee || f.fee || 0);
    ex.fills.push(f);
  } else {
    byOrderId.set(f.orderId, {
      orderId: f.orderId,
      btcQty: f.size,
      price: f.price,
      sizeUsdc: (f.quoteAmount || f.price * f.size) + (f.netFee || f.fee || 0),
      filledAt: f.timestamp,
      fills: [f],
    });
  }
}

for (const [, order] of byOrderId) {
  if (order.fills.length > 1) {
    const totalQuote = order.fills.reduce((s, f) => s + (f.quoteAmount || f.price * f.size), 0);
    order.price = totalQuote / order.btcQty;
  }
}

const unbodiedOrders = [...byOrderId.values()].sort((a, b) => a.filledAt - b.filledAt);
const fillBtc = unbodiedOrders.reduce((s, o) => s + o.btcQty, 0);
const fillCost = unbodiedOrders.reduce((s, o) => s + o.sizeUsdc, 0);

console.log(`\n📊 Found ${unbodiedOrders.length} un-bodied buy orders (${unbodiedBuys.length} fills):`);
for (const o of unbodiedOrders) {
  console.log(`   ${o.orderId.slice(0, 8)}: ${roundBTC(o.btcQty)} BTC @ $${roundUSDC(o.price)} ($${roundUSDC(o.sizeUsdc)}) [${new Date(o.filledAt).toISOString().slice(5, 19)}]`);
}
console.log(`   Fill total: ${roundBTC(fillBtc)} BTC, $${roundUSDC(fillCost)}`);
console.log(`   Recovery body total: ${recoveryBody.btcQty} BTC (includes holdback from 28+ completed bodies)`);

// ── Step 4: Update recovery body sourceOrderIds/buyOrders ──
// Keep btcQty/costBasis/avgPrice as-is since they came from exchange balance
// and include holdback BTC from completed bodies that we can't decompose
const newSourceOrderIds = unbodiedOrders.map(o => o.orderId);
const newBuyOrders = unbodiedOrders.map(o => ({
  orderId: o.orderId,
  price: o.price,
  btcQty: o.btcQty,
  sizeUsdc: roundUSDC(o.sizeUsdc),
  filledAt: o.filledAt,
}));

console.log(`\n🔧 Updating recovery body sourceOrderIds/buyOrders:`);
console.log(`   sourceOrderIds: [${recoveryBody.sourceOrderIds.join(', ')}] → [${newSourceOrderIds.map(id => id.slice(0, 8)).join(', ')}]`);
console.log(`   buyOrders: ${recoveryBody.buyOrders.length} → ${newBuyOrders.length}`);
console.log(`   btcQty/costBasis/avgPrice: UNCHANGED (exchange-derived, includes holdback)`);

// Clear the TP — the avgPrice ($72,340) was based on positionState.avgCostBasis
// (dominated by the sun body), not the actual fills. Engine will re-place on startup.
console.log(`\n🔧 Clearing TP order (avgPrice was wrong, engine will re-place):`);
console.log(`   tpOrderId: ${recoveryBody.tpOrderId} → null`);
console.log(`   tpPrice: $${recoveryBody.tpPrice} → 0`);
console.log(`   ⚠️  Old TP order ${recoveryBody.tpOrderId} will need to be cancelled on exchange`);

if (!DRY_RUN) {
  recoveryBody.sourceOrderIds = newSourceOrderIds;
  recoveryBody.buyOrders = newBuyOrders;
  recoveryBody.mergeCount = newBuyOrders.length - 1;
  // Clear TP so engine re-places at correct price
  recoveryBody.tpOrderId = null;
  recoveryBody.tpPrice = 0;
  recoveryBody.btcOnOrder = 0;
}

// ── Step 5: Annotate fills in ledger with bodyId ──
let annotated = 0;
for (const f of ledger) {
  if (f.side === 'buy' && byOrderId.has(f.orderId) && !f.bodyId) {
    if (!DRY_RUN) {
      f.isBodyOwned = true;
      f.bodyId = RECOVERY_BODY_ID;
      f.bodyTier = recoveryBody.tier;
    }
    annotated++;
  }
}
console.log(`\n📝 Annotated ${annotated} buy fills with bodyId=${RECOVERY_BODY_ID}`);

// ── Step 6: Annotate ec8b7bcb sell with body metadata ──
// Marks it as body-owned so dashboard doesn't use chronological fallback
const ec8bFills = ledger.filter(f => f.orderId === EC8B_ORDER_ID && f.side === 'sell');
console.log(`\n📝 Annotating ${ec8bFills.length} ec8b7bcb sell fill(s):`);
for (const f of ec8bFills) {
  console.log(`   ${f.tradeId.slice(0, 12)}: ${f.size} BTC @ $${f.price}`);
  if (!DRY_RUN) {
    f.isBodyOwned = true;
    f.bodyId = 'body-mli0qebf';
    f.bodyTier = 'satellite';
    f.isRecoverySell = true;
  }
}

// ── Step 7: Rebuild aggregates ──
if (!DRY_RUN) {
  let totalBodyBtc = 0;
  let totalBodyCost = 0;
  let totalBtcOnOrder = 0;
  for (const body of bodies) {
    totalBodyBtc += body.btcQty;
    totalBodyCost += body.costBasis;
    totalBtcOnOrder += body.btcOnOrder || 0;
  }
  const oldTotalBtc = pos.totalBTC;
  pos.totalBTC = roundBTC(totalBodyBtc);
  pos.totalCostBasis = roundUSDC(totalBodyCost);
  pos.avgCostBasis = totalBodyBtc > 0 ? totalBodyCost / totalBodyBtc : 0;
  pos.btcOnOrder = roundBTC(totalBtcOnOrder);

  console.log(`\n📊 Aggregates:`);
  console.log(`   totalBTC: ${oldTotalBtc} → ${pos.totalBTC}`);
  console.log(`   totalCostBasis: $${roundUSDC(totalBodyCost)}`);
  console.log(`   avgCostBasis: $${roundUSDC(pos.avgCostBasis)}`);
  console.log(`   btcOnOrder: ${roundBTC(totalBtcOnOrder)}`);
}

// ── Save ──
if (!DRY_RUN) {
  ledger.sort((a, b) => a.timestamp - b.timestamp);

  const backupLedger = LEDGER_PATH + '.backup-fixbody-' + Date.now();
  const backupState = STATE_PATH + '.backup-fixbody-' + Date.now();
  fs.copyFileSync(LEDGER_PATH, backupLedger);
  fs.copyFileSync(STATE_PATH, backupState);
  console.log(`\n💾 Backups: ${path.basename(backupLedger)}, ${path.basename(backupState)}`);

  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log('✅ fill-ledger.json saved');

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log('✅ regime-state.json saved');
}

// ── Verification ──
console.log('\n🔍 Verification:');
const fakeIds = (DRY_RUN ? recoveryBody.sourceOrderIds : recoveryBody.sourceOrderIds).filter(id => id.startsWith('recovery-'));
console.log(`   Fake orderIds remaining: ${fakeIds.length} ${fakeIds.length === 0 ? '✅' : '❌ ' + fakeIds.join(', ')}`);
const ec8bBuysLinked = ledger.filter(f => f.sellOrderId === EC8B_ORDER_ID).length;
console.log(`   ec8b7bcb linked buys: ${ec8bBuysLinked} ${ec8bBuysLinked === 0 ? '✅' : '❌'}`);
const ec8bAnnotated = DRY_RUN ? 0 : ledger.filter(f => f.orderId === EC8B_ORDER_ID && (f.isBodyOwned || f.isSatellite)).length;
console.log(`   ec8b7bcb sell annotated: ${ec8bAnnotated > 0 ? '✅' : `❌ (dry-run: ${DRY_RUN})`}`);
const recoveryFills = DRY_RUN ? 0 : ledger.filter(f => f.bodyId === RECOVERY_BODY_ID).length;
console.log(`   Recovery body fills annotated: ${recoveryFills}`);
console.log(`\n⚠️  After running this, cancel the old TP order on Coinbase:`);
console.log(`   Order ID: 08269d19-911b-4e9b-a764-b10cd385e210`);
console.log(`   Then start the engine — it will place new TP at correct price.`);
console.log('');
