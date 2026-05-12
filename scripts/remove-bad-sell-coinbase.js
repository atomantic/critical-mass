#!/usr/bin/env node
/**
 * One-off cleanup for coinbase BTC-USDC: removes the bad 1.0 BTC sell
 * (orderId 7a3c8ef8-...) and unlinks the only buy that was annotated to it
 * (orderId 4ea191b2-...). Backs up fill-ledger.json with a timestamp suffix.
 *
 * Usage:
 *   node scripts/remove-bad-sell-coinbase.js          # dry-run
 *   node scripts/remove-bad-sell-coinbase.js --apply  # writes
 */

const fs = require('fs');
const path = require('path');

const apply = process.argv.includes('--apply');
const LEDGER = path.join(__dirname, '..', 'data', 'coinbase', 'BTC-USDC', 'fill-ledger.json');
const BAD_SELL = '7a3c8ef8-b303-404b-99f0-45f8ed9edeeb';
const ORPHANED_BUY = '4ea191b2-7863-43c4-97e5-0aaf8420b6c0';

const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const fills = Array.isArray(raw) ? raw : Object.values(raw);
const before = fills.length;

const removed = [];
const kept = [];
for (const f of fills) {
  if (f.orderId === BAD_SELL && f.side === 'sell') {
    removed.push(f);
  } else {
    kept.push(f);
  }
}

let unlinked = 0;
for (const f of kept) {
  if (f.orderId === ORPHANED_BUY && f.sellOrderId === BAD_SELL) {
    delete f.sellOrderId;
    delete f.isBodyOwned;
    delete f.bodyId;
    delete f.bodyTier;
    unlinked++;
  }
}

const removedQty = removed.reduce((s, f) => s + (Number(f.size) || 0), 0);
const removedProceeds = removed.reduce((s, f) => s + (Number(f.quoteAmount) || 0), 0);
const removedFees = removed.reduce((s, f) => s + (Number(f.netFee) || 0), 0);

console.log(`Coinbase BTC-USDC fill-ledger cleanup`);
console.log(`  Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`  Total fills before: ${before}`);
console.log(`  Removing ${removed.length} sell fills with orderId ${BAD_SELL}`);
console.log(`    sumSize: ${removedQty}`);
console.log(`    sumQuoteAmount: ${removedProceeds.toFixed(2)}`);
console.log(`    sumNetFee: ${removedFees.toFixed(4)}`);
console.log(`  Unlinking ${unlinked} buy fill (cleared sellOrderId/body annotations) for orderId ${ORPHANED_BUY}`);
console.log(`  Total fills after: ${kept.length}`);

if (apply) {
  const backup = `${LEDGER}.backup-remove-bad-sell-${Date.now()}`;
  fs.copyFileSync(LEDGER, backup);
  fs.writeFileSync(LEDGER, JSON.stringify(kept, null, 2));
  console.log(`  ✓ written (backup: ${path.basename(backup)})`);
} else {
  console.log(`  (Re-run with --apply to write.)`);
}
