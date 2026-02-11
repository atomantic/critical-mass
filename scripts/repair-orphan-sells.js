#!/usr/bin/env node
/**
 * Repair orphan sell fills that have no linked buy orders
 *
 * Root cause: Duplicate TP bug placed two sell orders for the same celestial body.
 * The buys are linked to the first sell via sellOrderId, leaving the second sell
 * with no buy linkage.
 *
 * Fixes:
 * 1. 3b5737ff: Add bodyId so dashboard bodyId fallback finds shared buys
 * 2. 9e935edf: Add bodyId for display (early duplicate TP, buys linked to fe7ce067)
 * 3. f6369787: Already has bodyId, verify it's correct
 *
 * Usage: node scripts/repair-orphan-sells.js [--apply]
 */

const fs = require('fs');
const path = require('path');

const dryRun = !process.argv.includes('--apply');
const ledgerPath = path.join(__dirname, '..', 'data', 'coinbase', 'fill-ledger.json');

const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const fills = Object.values(data);
const keys = Object.keys(data);

let changes = 0;

const repairs = [
  {
    sellOrderPrefix: '3b5737ff',
    bodyId: 'body-ba245864-mlf4r8dr',
    note: 'Duplicate TP of da726af9 (same body, placed 21min later due to duplicate TP bug)',
  },
  {
    sellOrderPrefix: '9e935edf',
    // buys were bf15e9df + b16f23dc + 060d67ce from cycle-2, but linked to core TP fe7ce067
    // No clear bodyId — this was a pre-celestial satellite. Use a synthetic marker.
    bodyId: null, // Will be handled by duplicateTpOf field
    duplicateTpOf: 'fe7ce067',
    note: 'Early satellite TP, buys linked to core TP fe7ce067 (cycle-2 era, pre-celestial)',
  },
  {
    sellOrderPrefix: 'f6369787',
    bodyId: 'body-27354c01-mlij69f5',  // Already set, just verify
    note: 'Duplicate TP of 31159418 (same body-27354c01, placed due to duplicate TP bug)',
  },
];

for (const repair of repairs) {
  for (let i = 0; i < keys.length; i++) {
    const fill = data[keys[i]];
    if (!fill.orderId || !fill.orderId.startsWith(repair.sellOrderPrefix)) continue;
    if (fill.side !== 'sell') continue;

    console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}Processing sell ${fill.orderId.slice(0, 8)}:`);
    console.log(`  Current bodyId: ${fill.bodyId || 'none'}`);
    console.log(`  Current duplicateTpNote: ${fill.duplicateTpNote || 'none'}`);

    if (repair.bodyId && fill.bodyId !== repair.bodyId) {
      console.log(`  → Setting bodyId: ${repair.bodyId}`);
      fill.bodyId = repair.bodyId;
      changes++;
    } else if (repair.bodyId && fill.bodyId === repair.bodyId) {
      console.log(`  ✓ bodyId already correct`);
    }

    if (repair.duplicateTpOf && !fill.duplicateTpOf) {
      console.log(`  → Setting duplicateTpOf: ${repair.duplicateTpOf}`);
      fill.duplicateTpOf = repair.duplicateTpOf;
      changes++;
    }

    if (!fill.duplicateTpNote) {
      console.log(`  → Setting duplicateTpNote: ${repair.note}`);
      fill.duplicateTpNote = repair.note;
      changes++;
    }
  }
}

// Verify: check linked buys after repair
console.log('\n--- Verification ---');
for (const repair of repairs) {
  const sell = fills.find(f => f.orderId && f.orderId.startsWith(repair.sellOrderPrefix) && f.side === 'sell');
  if (!sell) { console.log(`${repair.sellOrderPrefix}: NOT FOUND`); continue; }

  const directBuys = fills.filter(f => f.sellOrderId === sell.orderId && f.side === 'buy');
  const bodyBuys = sell.bodyId ? fills.filter(f => f.bodyId === sell.bodyId && f.side === 'buy') : [];

  console.log(`${sell.orderId.slice(0, 8)}: direct=${directBuys.length} bodyFallback=${bodyBuys.length} bodyId=${sell.bodyId || 'none'}`);
}

if (changes === 0) {
  console.log('\nNo changes needed.');
} else if (dryRun) {
  console.log(`\n${changes} changes would be made. Run with --apply to persist.`);
} else {
  // Backup
  const backupPath = `${ledgerPath}.backup-orphan-repair-${Date.now()}`;
  fs.copyFileSync(ledgerPath, backupPath);
  console.log(`\nBackup: ${backupPath}`);

  fs.writeFileSync(ledgerPath, JSON.stringify(data, null, 2));
  console.log(`${changes} changes applied to ${ledgerPath}`);
}
