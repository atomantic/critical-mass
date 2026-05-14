#!/usr/bin/env node
/**
 * Recover orphan buy fills in the CURRENT cycle into their natural celestial body.
 *
 * An "orphan" is a buy fill in the fill ledger that has no bodyId — typically
 * because `handleOrderFill` was interrupted (SIGINT during pm2 restart, etc.)
 * between `fillLedger.ingestFill` and the body-merge/annotation step. The fill
 * persists, but the body never learned about it.
 *
 * What this script does (per orphan order in the current cycle):
 *   1. Aggregate the order's ledger fills (qty, cost incl. fees, avgPrice).
 *   2. Pick a merge target via celestial-hierarchy.findMergeTarget (same logic
 *      the live engine uses on a fresh fill).
 *   3. Mutate the target body: bump assetQty/costBasis/avgPrice, append the
 *      orphan to buyOrders/sourceOrderIds, set lastMergedAt to the fill time.
 *   4. Annotate the ledger fills with {isBodyOwned, bodyId, bodyTier,
 *      sellOrderId} so dashboards / FIFO replay attribute them correctly.
 *
 * Note on the on-exchange TP order: this script does NOT cancel-replace the
 * body's TP. The body now has more assetQty than its TP covers (the orphan's
 * qty is sitting in free balance on the exchange). The engine's reconcile loop
 * (regime-engine.js: "Pure stale-size detection") sees the
 * `body.assetQty != assetOnOrder` mismatch on the next tick and triggers a
 * cancel-replace at the correct new size. So just restart the engine after
 * applying.
 *
 * Engine MUST be stopped: pm2 stop critical-mass-cryptocom
 * Refuses to run if state file was touched in the last 15 seconds.
 *
 * Usage:
 *   node scripts/cryptocom-recover-orphan-buys.js          # dry-run
 *   node scripts/cryptocom-recover-orphan-buys.js --apply  # writes
 */
const fs = require('fs');
const path = require('path');
const { findMergeTarget, classifyTier, getTierConfig } = require('../src/celestial-hierarchy');

const APPLY = process.argv.includes('--apply');
const DIR = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD');
const stateFile = path.join(DIR, 'regime-state.json');
const ledgerFile = path.join(DIR, 'fill-ledger.json');
const configFile = path.join(__dirname, '..', 'data', 'config.json');

const stateAge = (Date.now() - fs.statSync(stateFile).mtimeMs) / 1000;
if (stateAge < 15) {
  console.error(`⛔ regime-state.json was modified ${stateAge.toFixed(0)}s ago — engine likely running.`);
  console.error('   Stop it first: pm2 stop critical-mass-cryptocom');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));

// Engine config for findMergeTarget (max bodies, capital, proximity scale)
const fundCfg = config.cryptocom?.funds?.CRO_USD?.regime
  || config.funds?.find(f => f.exchange === 'cryptocom' && f.productId === 'CRO_USD')?.regime
  || {};
const maxUsdcDeployed = fundCfg.maxUsdcDeployed
  || config.cryptocom?.funds?.CRO_USD?.maxUsdcDeployed
  || state.position?.depositedCapital
  || 7000;
const maxCelestialBodies = fundCfg.maxCelestialBodies || 10;
const maxOpenOrders = fundCfg.maxOpenOrders || 5;
const proximityScale = fundCfg.mergeProximityScale ?? 1.0;
const defaultTpPct = fundCfg.tpPct || 2.0;

const bodies = state.position?.celestialBodies || [];
if (bodies.length === 0) {
  console.error('⛔ No celestial bodies in state — nothing to merge orphans into');
  process.exit(1);
}

// Identify current cycle
const cycleIds = [...new Set(ledger.map(f => f.cycleId).filter(Boolean))];
const currentCycle = cycleIds.sort((a, b) => {
  const an = parseInt(a.split('-').pop()) || 0;
  const bn = parseInt(b.split('-').pop()) || 0;
  return bn - an;
})[0];
console.log(`Current cycle (newest in ledger): ${currentCycle}`);

// Find orphan buys in current cycle
const currentCycleFills = ledger.filter(f => f.cycleId === currentCycle);
const orphanBuyFills = currentCycleFills.filter(f =>
  f.side === 'buy' && !f.bodyId && !String(f.tradeId).startsWith('dca-convert')
);

if (orphanBuyFills.length === 0) {
  console.log('✅ No orphan buys in current cycle');
  process.exit(0);
}

// Group orphan fills by orderId (one merge per order)
const orphansByOrderId = {};
for (const f of orphanBuyFills) {
  if (!orphansByOrderId[f.orderId]) orphansByOrderId[f.orderId] = [];
  orphansByOrderId[f.orderId].push(f);
}

console.log(`\nFound ${Object.keys(orphansByOrderId).length} orphan orders (${orphanBuyFills.length} fills) in ${currentCycle}\n`);

let totalMerged = 0;
for (const [orderId, fills] of Object.entries(orphansByOrderId)) {
  const totalSize = fills.reduce((s, f) => s + f.size, 0);
  const totalValue = fills.reduce((s, f) => s + (f.quoteAmount || f.size * f.price), 0);
  const totalFees = fills.reduce((s, f) => s + (f.netFee || f.fee || 0), 0);
  const totalCost = totalValue + totalFees;
  const avgPrice = totalCost / totalSize;
  const fillTime = Math.max(...fills.map(f => f.timestamp));

  const newBuy = { assetQty: totalSize, costBasis: totalCost, avgPrice, buyOrderId: orderId };
  const candidateTpPrice = avgPrice * (1 + defaultTpPct / 100);
  // Only consider bodies that existed at the orphan's fill time — this is what
  // would have happened if the live engine hadn't been interrupted mid-flow.
  const eligibleBodies = bodies.filter(b => !b.createdAt || b.createdAt <= fillTime);
  let target = findMergeTarget(
    eligibleBodies, newBuy, maxUsdcDeployed, candidateTpPrice,
    maxCelestialBodies, 0, maxOpenOrders, proximityScale
  );
  // Fallback: no tier-proximity match. The orphan still has to go somewhere,
  // so pick the historically-eligible body whose tpPrice is closest to the
  // orphan's candidate TP (same rule the engine uses when at body capacity).
  if (!target) {
    let bestDist = Infinity;
    for (const b of eligibleBodies) {
      if (!b.tpPrice || b.tpPrice <= 0) continue;
      const d = Math.abs(b.tpPrice - candidateTpPrice);
      if (d < bestDist) { bestDist = d; target = b; }
    }
    if (target) console.log(`  (no proximity match — using closest-tpPrice fallback)`);
  }

  console.log(`Orphan order ${orderId}:`);
  console.log(`  fills: ${fills.length} (${fills.map(f => f.tradeId).join(', ')})`);
  console.log(`  qty: ${totalSize} CRO @ avg $${avgPrice.toFixed(5)} = $${totalCost.toFixed(4)}`);
  console.log(`  fillTime: ${new Date(fillTime).toISOString()}`);

  if (!target) {
    console.log(`  ⚠️  No merge target found (would need new body) — skipping, this script only merges into existing bodies`);
    continue;
  }
  console.log(`  → target body: ${target.id} (tier=${target.tier}, qty=${target.assetQty}, avg=$${target.avgPrice.toFixed(5)})`);

  const beforeQty = target.assetQty;
  const beforeCost = target.costBasis;

  // Mutate body (mirror celestial-hierarchy.mergeIntoBody but with fillTime not Date.now())
  target.assetQty = Math.round((target.assetQty + totalSize) * 1e8) / 1e8;
  target.costBasis = Math.round((target.costBasis + totalCost) * 100) / 100;
  target.avgPrice = target.assetQty > 0 ? target.costBasis / target.assetQty : 0;
  target.lastMergedAt = fillTime;
  target.sourceOrderIds = target.sourceOrderIds || [];
  if (!target.sourceOrderIds.includes(orderId)) target.sourceOrderIds.push(orderId);
  target.buyOrders = target.buyOrders || [];
  target.buyOrders.push({
    orderId,
    price: avgPrice,
    assetQty: totalSize,
    sizeUsdc: totalCost,
    filledAt: fillTime,
  });
  target.mergeCount = (target.mergeCount || 0) + 1;

  // Tier promotion
  const newTier = classifyTier(target.costBasis, maxUsdcDeployed);
  if (newTier.name !== target.tier) {
    const oldTier = target.tier;
    target.tier = newTier.name;
    const pct = maxUsdcDeployed > 0 ? ((target.costBasis / maxUsdcDeployed) * 100).toFixed(1) : '0';
    console.log(`  ⬆️ promoted: ${getTierConfig(oldTier).emoji} ${oldTier} → ${newTier.emoji} ${newTier.name} (${pct}% of capital, $${target.costBasis.toFixed(0)})`);
  }

  // Annotate ledger fills
  const annotation = { isBodyOwned: true, bodyId: target.id, bodyTier: target.tier };
  if (target.tpOrderId) annotation.sellOrderId = target.tpOrderId;
  for (const f of fills) Object.assign(f, annotation);

  console.log(`  body after: qty ${beforeQty} → ${target.assetQty} (+${totalSize}), cost $${beforeCost.toFixed(2)} → $${target.costBasis.toFixed(2)} (+$${totalCost.toFixed(2)})`);
  console.log();
  totalMerged++;
}

// Recompute position aggregates
const totalAsset = state.position.celestialBodies.reduce((s, b) => s + (b.assetQty || 0), 0);
const totalCostBasis = state.position.celestialBodies.reduce((s, b) => s + (b.costBasis || 0), 0);
const before = { totalAsset: state.position.totalAsset, totalCostBasis: state.position.totalCostBasis };
state.position.totalAsset = Math.round(totalAsset * 1e8) / 1e8;
state.position.totalCostBasis = Math.round(totalCostBasis * 100) / 100;
state.position.avgCostBasis = totalAsset > 0 ? state.position.totalCostBasis / totalAsset : 0;

console.log(`Merged ${totalMerged} orphan order(s)`);
console.log(`Position totals: asset ${before.totalAsset} → ${state.position.totalAsset}, cost $${before.totalCostBasis.toFixed(2)} → $${state.position.totalCostBasis.toFixed(2)}`);

if (!APPLY) {
  console.log('\nDRY RUN. Pass --apply to write changes.');
  console.log('Reminder: stop engine first → pm2 stop critical-mass-cryptocom');
  process.exit(0);
}

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
console.log('\n✅ Wrote state and ledger.');
console.log('Next: pm2 start critical-mass-cryptocom');
console.log('The engine\'s reconcile loop will detect each merged body\'s TP-size mismatch on the next tick and cancel-replace.');
