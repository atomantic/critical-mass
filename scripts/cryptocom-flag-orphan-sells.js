#!/usr/bin/env node
/**
 * Flag sells whose buys can't be paired as `untrackedSell: true` so the UI
 * shows the existing "(orphan)" badge + explanation note instead of a bare
 * "1 sell, 0 buys" cycle.
 *
 * Triggers on: no buy in the ledger has sellOrderId == this sell's orderId,
 * AND the sell has no bodyId (or its bodyId has no buys either).
 *
 * The sell's proceeds are still counted in the FIFO realized PnL — this is
 * purely a display annotation.
 *
 * Idempotent. Engine MUST be stopped.
 *
 * Usage:
 *   node scripts/cryptocom-flag-orphan-sells.js           # dry-run
 *   node scripts/cryptocom-flag-orphan-sells.js --apply   # writes
 */
const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD', 'fill-ledger.json');
const APPLY = process.argv.includes('--apply');

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));

const buysWithSellOid = new Set();
const buysByBodyId = new Map();
for (const f of ledger) {
  if (f.side !== 'buy') continue;
  if (f.sellOrderId) buysWithSellOid.add(String(f.sellOrderId));
  if (f.bodyId) {
    if (!buysByBodyId.has(f.bodyId)) buysByBodyId.set(f.bodyId, 0);
    buysByBodyId.set(f.bodyId, buysByBodyId.get(f.bodyId) + 1);
  }
}

const orphans = [];
const touched = new Set();
for (const f of ledger) {
  if (f.side !== 'sell') continue;
  if (f.untrackedSell) continue; // already flagged
  if (buysWithSellOid.has(String(f.orderId))) continue;
  // No buys with sellOrderId matching this sell. Check if bodyId fallback would find any.
  if (f.bodyId && buysByBodyId.has(f.bodyId)) continue;
  // No link path → orphan. Flag.
  f.untrackedSell = true;
  if (!touched.has(String(f.orderId))) {
    touched.add(String(f.orderId));
    orphans.push({
      orderId: f.orderId,
      ts: new Date(f.timestamp).toISOString(),
      qty: f.size,
      bodyId: f.bodyId,
    });
  }
}

console.log(`Flagged ${orphans.length} sell orders (${ledger.filter(f => f.side === 'sell' && f.untrackedSell).length} fills) as untrackedSell:`);
for (const o of orphans) console.log(`  ${o.orderId} (${o.ts}) qty=${o.qty} body=${o.bodyId || '-'}`);

if (!APPLY) {
  console.log(`\nDry-run — pass --apply to write.`);
  process.exit(0);
}

const bp = `${LEDGER_PATH}.backup-flag-${Date.now()}`;
fs.copyFileSync(LEDGER_PATH, bp);
console.log(`💾 Backup: ${path.basename(bp)}`);
fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
console.log(`✅ Wrote ledger with ${orphans.length} sells flagged as untracked`);
