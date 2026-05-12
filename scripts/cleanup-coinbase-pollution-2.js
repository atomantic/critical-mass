#!/usr/bin/env node
/**
 * Coinbase BTC-USDC pollution cleanup, round 2:
 *  1) Relink orphaned buy 4ea191b2-... back to its rightful planet sell
 *     d62b63e2-... (restores the body's full bodyBtcQty attribution).
 *  2) Delete the unattributed 1.0 BTC orphan sell ef8ad8de-... (no body, no
 *     linked buys, exactly 1.0 BTC at $71,500 — same pollution pattern as
 *     the previously deleted 7a3c8ef8-...).
 *
 * Usage:
 *   node scripts/cleanup-coinbase-pollution-2.js          # dry-run
 *   node scripts/cleanup-coinbase-pollution-2.js --apply  # writes
 */

const fs = require('fs');
const path = require('path');

const apply = process.argv.includes('--apply');
const LEDGER = path.join(__dirname, '..', 'data', 'coinbase', 'BTC-USDC', 'fill-ledger.json');

const ORPHANED_BUY = '4ea191b2-7863-43c4-97e5-0aaf8420b6c0';
const RIGHTFUL_SELL = 'd62b63e2-b0b8-4ad7-8a57-49b3fc7b2bfe';
const ORPHAN_SELL_TO_DELETE = 'ef8ad8de-57a5-4b1f-8356-75370f0184f3';

const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const fills = Array.isArray(raw) ? raw : Object.values(raw);
const before = fills.length;

const removed = [];
const kept = [];
for (const f of fills) {
  if (f.orderId === ORPHAN_SELL_TO_DELETE && f.side === 'sell') {
    removed.push(f);
  } else {
    kept.push(f);
  }
}

let relinked = 0;
for (const f of kept) {
  if (f.orderId === ORPHANED_BUY && f.side === 'buy') {
    f.sellOrderId = RIGHTFUL_SELL;
    f.isBodyOwned = true;
    f.bodyId = 'body-9be005b3-mlv1rsa1';
    f.bodyTier = 'planet';
    relinked++;
  }
}

const removedSize = removed.reduce((s, f) => s + (Number(f.size) || 0), 0);
const removedQuote = removed.reduce((s, f) => s + (Number(f.quoteAmount) || 0), 0);

console.log(`Coinbase BTC-USDC pollution cleanup #2`);
console.log(`  Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`  Total fills before: ${before}`);
console.log(`  (1) Relinked ${relinked} buy fill: ${ORPHANED_BUY} -> sellOrderId ${RIGHTFUL_SELL}`);
console.log(`      (also restored isBodyOwned, bodyId, bodyTier)`);
console.log(`  (2) Removed ${removed.length} sell fill(s) for orphan order ${ORPHAN_SELL_TO_DELETE}`);
console.log(`      sumSize: ${removedSize}, sumQuoteAmount: ${removedQuote.toFixed(2)}`);
console.log(`  Total fills after: ${kept.length}`);

if (apply) {
  const backup = `${LEDGER}.backup-cleanup2-${Date.now()}`;
  fs.copyFileSync(LEDGER, backup);
  fs.writeFileSync(LEDGER, JSON.stringify(kept, null, 2));
  console.log(`  ✓ written (backup: ${path.basename(backup)})`);
} else {
  console.log(`  (Re-run with --apply to write.)`);
}
