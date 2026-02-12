#!/usr/bin/env node
/**
 * Fix orphan cycle-12 sell fill (9e935edf)
 *
 * Root cause: A body TP cancel-and-replace resulted in both the old and new TP orders
 * filling simultaneously. The first was processed correctly as a body TP. The second
 * was treated as an "untracked sell" which falsely completed the cycle and started cycle-12.
 * An old sell (9e935edf from Feb 3) was subsequently ingested into the wrong cycle.
 *
 * This script:
 * 1. Moves the 9e935edf sell from cycle-12 to cycle-11 and annotates it
 * 2. Verifies no other cycle-12 fills exist
 *
 * Usage: node scripts/fix-cycle12-orphan.js [--apply]
 */

const fs = require('fs');
const path = require('path');

const dryRun = !process.argv.includes('--apply');
const ledgerPath = path.join(__dirname, '..', 'data', 'coinbase', 'fill-ledger.json');

if (dryRun) {
  console.log('🔍 DRY RUN — pass --apply to make changes\n');
}

const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
console.log(`📖 Loaded ${data.length} fills`);

// Find cycle-12 fills
const cycle12 = data.filter(f => f.cycleId === 'cycle-12');
console.log(`🔎 Found ${cycle12.length} cycle-12 fill(s)`);

if (cycle12.length !== 1 || cycle12[0].orderId !== '9e935edf-1893-4ed1-941b-673b7cb6c469') {
  console.log('❌ Unexpected cycle-12 state — expected exactly 1 fill (9e935edf). Aborting.');
  process.exit(1);
}

const orphanFill = cycle12[0];
console.log(`\n📋 Orphan fill: ${orphanFill.orderId.slice(0, 8)} | ${orphanFill.side} ${orphanFill.size} BTC @ $${orphanFill.price}`);
console.log(`   Filled: ${new Date(orphanFill.timestamp).toISOString()}`);
console.log(`   Ingested: ${new Date(orphanFill.ingestedAt).toISOString()}`);
console.log(`   Current cycle: ${orphanFill.cycleId}`);

// Move to cycle-11 and annotate
console.log(`\n✏️  Moving from cycle-12 → cycle-11, annotating as untrackedSell`);

if (!dryRun) {
  const backupPath = `${ledgerPath}.backup-fixcycle12-${Date.now()}`;
  fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));
  console.log(`💾 Backup: ${backupPath}`);

  const idx = data.findIndex(f => f.orderId === '9e935edf-1893-4ed1-941b-673b7cb6c469');
  data[idx].cycleId = 'cycle-11';
  data[idx].untrackedSell = true;
  data[idx].fixNote = 'Moved from cycle-12 (orphan from false cycle completion via duplicate body TP fill)';

  fs.writeFileSync(ledgerPath, JSON.stringify(data, null, 2));
  console.log('✅ Fill ledger updated');
} else {
  console.log('   (dry run — no changes made)');
}

console.log('\n✅ Done');
