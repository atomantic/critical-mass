#!/usr/bin/env node
/**
 * Backfill sellOrderId on buy fills
 *
 * Adds a `sellOrderId` field to historical buy fills so the dashboard
 * can group buys under their sell orders without fragile chronological walks.
 *
 * Usage:
 *   node scripts/backfill-sell-order-ids.js                              # dry-run (prints summary)
 *   node scripts/backfill-sell-order-ids.js --apply                      # persist changes
 *   node scripts/backfill-sell-order-ids.js --tp-order-id=<id> --apply   # explicit core TP for active cycle
 */

const fs = require('fs');
const path = require('path');

const FILL_LEDGER_PATH = path.join(__dirname, '..', 'data', 'coinbase', 'fill-ledger.json');
const REGIME_STATE_PATH = path.join(__dirname, '..', 'data', 'coinbase', 'regime-state.json');

const apply = process.argv.includes('--apply');
const tpOrderIdArg = process.argv.find(a => a.startsWith('--tp-order-id='));
const explicitTpOrderId = tpOrderIdArg ? tpOrderIdArg.split('=')[1] : null;

const fills = JSON.parse(fs.readFileSync(FILL_LEDGER_PATH, 'utf8'));
const regimeState = JSON.parse(fs.readFileSync(REGIME_STATE_PATH, 'utf8'));
const positionState = regimeState.positionState || {};
const celestialBodies = positionState.celestialBodies || [];

// Group fills by cycleId
const cycleMap = new Map();
fills.forEach(f => {
  if (!f.cycleId) return;
  if (!cycleMap.has(f.cycleId)) cycleMap.set(f.cycleId, []);
  cycleMap.get(f.cycleId).push(f);
});

// Determine completed vs active cycles (same heuristic as fill-ledger.js)
const completedCycleIds = new Set();
let activeCycleId = null;

for (const [cycleId, cycleFills] of cycleMap) {
  let buysBtc = 0;
  let sellsBtc = 0;
  for (const f of cycleFills) {
    if (f.side === 'buy') buysBtc += f.size;
    else if (f.side === 'sell') sellsBtc += f.size;
  }
  const sellRatio = buysBtc > 0 ? sellsBtc / buysBtc : 0;
  if (sellRatio >= 0.5) {
    completedCycleIds.add(cycleId);
  } else {
    activeCycleId = cycleId;
  }
}

let assigned = 0;
let skipped = 0;

// A. Completed cycles: assign all buys to the dominant sell orderId
for (const cycleId of completedCycleIds) {
  const cycleFills = cycleMap.get(cycleId);
  const sells = cycleFills.filter(f => f.side === 'sell' && !f.isSatellite);
  const buys = cycleFills.filter(f => f.side === 'buy');

  // Find unique non-satellite sell orderIds
  const sellOrderIds = [...new Set(sells.map(s => s.orderId))];

  let targetSellOrderId = null;
  if (sellOrderIds.length === 1) {
    targetSellOrderId = sellOrderIds[0];
  } else if (sellOrderIds.length > 1) {
    // Multiple sell orderIds: pick the one with highest total BTC sold
    const sellBtcByOrderId = new Map();
    sells.forEach(s => {
      sellBtcByOrderId.set(s.orderId, (sellBtcByOrderId.get(s.orderId) || 0) + s.size);
    });
    targetSellOrderId = [...sellBtcByOrderId.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  if (targetSellOrderId) {
    for (const buy of buys) {
      if (!buy.sellOrderId) {
        buy.sellOrderId = targetSellOrderId;
        assigned++;
      }
    }
  }
}

// B-E. Active cycle
if (activeCycleId) {
  const cycleFills = cycleMap.get(activeCycleId) || [];
  const buys = cycleFills.filter(f => f.side === 'buy');
  const sells = cycleFills.filter(f => f.side === 'sell');

  // Build body lookup from celestialBodies in regime state
  const bodyById = new Map(celestialBodies.map(b => [b.id, b]));

  // Build satellite sell lookup by orderId
  const satSells = sells.filter(s => s.isSatellite);

  // Track which sells have been consumed by matching
  const consumedSellIds = new Set();

  for (const buy of buys) {
    if (buy.sellOrderId) { skipped++; continue; }

    // B. Satellite buy with bodyId — look up body's tpOrderId
    if (buy.isSatellite && buy.bodyId) {
      const body = bodyById.get(buy.bodyId);
      if (body && body.tpOrderId) {
        buy.sellOrderId = body.tpOrderId;
        assigned++;
        continue;
      }
      // Body not in state (already sold). Match via satellite sell heuristic.
      const matchingSell = satSells.find(s => {
        if (consumedSellIds.has(s.orderId)) return false;
        const sizeRatio = buy.size / s.size;
        return sizeRatio > 0.99 && sizeRatio < 1.01 && buy.timestamp < s.timestamp;
      });
      if (matchingSell) {
        buy.sellOrderId = matchingSell.orderId;
        consumedSellIds.add(matchingSell.orderId);
        assigned++;
        continue;
      }
      // Unresolvable
      skipped++;
      continue;
    }

    // C. Satellite buy without bodyId (legacy)
    if (buy.isSatellite && !buy.bodyId) {
      // Heuristic: find satellite sell with similar BTC size and closest timestamp
      const candidates = satSells.filter(s => {
        if (consumedSellIds.has(s.orderId)) return false;
        const sizeRatio = buy.size / s.size;
        return sizeRatio > 0.99 && sizeRatio < 1.01 && buy.timestamp < s.timestamp;
      });
      if (candidates.length > 0) {
        // Pick closest in time
        const best = candidates.reduce((a, b) =>
          (a.timestamp - buy.timestamp) < (b.timestamp - buy.timestamp) ? a : b
        );
        buy.sellOrderId = best.orderId;
        consumedSellIds.add(best.orderId);
        assigned++;
      } else {
        skipped++;
      }
      continue;
    }

    // D. Non-satellite buy: assign to core TP if exists
    if (!buy.isSatellite) {
      const coreTpOrderId = explicitTpOrderId || positionState.activeTpOrderId;
      if (coreTpOrderId) {
        buy.sellOrderId = coreTpOrderId;
        assigned++;
      } else {
        // No active core TP — these buys are pending
        skipped++;
      }
      continue;
    }
  }
}

// Summary
const buysTotal = fills.filter(f => f.side === 'buy').length;
const withSellOrderId = fills.filter(f => f.side === 'buy' && f.sellOrderId).length;

console.log('=== Backfill sellOrderId Summary ===');
console.log(`Total buy fills: ${buysTotal}`);
console.log(`Assigned sellOrderId: ${assigned}`);
console.log(`Already had sellOrderId: ${withSellOrderId - assigned}`);
console.log(`Skipped (unresolvable/pending): ${skipped}`);
console.log(`Final buys with sellOrderId: ${withSellOrderId}`);
console.log(`Completed cycles: ${completedCycleIds.size}`);
console.log(`Active cycle: ${activeCycleId || 'none'}`);
console.log(`Mode: ${apply ? 'APPLY (persisting)' : 'DRY-RUN (no changes written)'}`);

if (apply) {
  fs.writeFileSync(FILL_LEDGER_PATH, JSON.stringify(fills, null, 2));
  console.log(`\nWrote updated fill-ledger.json (${fills.length} fills)`);
} else {
  console.log('\nRun with --apply to persist changes.');
}
