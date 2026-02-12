#!/usr/bin/env node
/**
 * Fix cycle numbering after recalculateCycles inserted orphan cycles.
 *
 * The recalculateCycles() on startup:
 *   - Inserted orphan group 1 (2 fills) as completed cycle-3, shifting 3→4, 4→5, etc.
 *   - Created orphan group 2 as active cycle-12
 *   - Pushed our active cycle-11 to cycle-13
 *
 * Fix: undo the insertion, merge orphans into cycle-11, restore original numbering.
 *
 * Usage: node scripts/fix-cycle-numbering.js
 */

const fs = require('fs');
const path = require('path');
const { roundBTC, roundUSDC } = require('../src/volatility-utils');

const LEDGER_PATH = path.join(__dirname, '../data/coinbase/fill-ledger.json');
const STATE_PATH = path.join(__dirname, '../data/coinbase/regime-state.json');

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

// Cycle remapping:
// cycle-3 → cycle-11  (orphan group, merge into active)
// cycle-4 → cycle-3   (was original cycle-3)
// cycle-5 → cycle-4   (was original cycle-4)
// ... etc ...
// cycle-11 → cycle-10 (was original cycle-10)
// cycle-12 → cycle-11 (orphan group 2, merge into active)
// cycle-13 → cycle-11 (the actual active cycle)
const remap = new Map();
remap.set('cycle-3', 'cycle-11');
for (let i = 4; i <= 11; i++) {
  remap.set(`cycle-${i}`, `cycle-${i - 1}`);
}
remap.set('cycle-12', 'cycle-11');
remap.set('cycle-13', 'cycle-11');

console.log('🔧 Cycle remapping:');
for (const [from, to] of remap) {
  const count = ledger.filter(f => f.cycleId === from).length;
  console.log(`   ${from} (${count} fills) → ${to}`);
}

// Apply remapping
let changes = 0;
for (const fill of ledger) {
  const newCycleId = remap.get(fill.cycleId);
  if (newCycleId) {
    fill.cycleId = newCycleId;
    changes++;
  }
}

console.log(`\n✅ Remapped ${changes} fills`);

// Verify cycle distribution
const cycles = {};
for (const f of ledger) {
  cycles[f.cycleId || 'null'] = (cycles[f.cycleId || 'null'] || 0) + 1;
}
console.log('\n📊 New cycle distribution:');
for (const [cid, count] of Object.entries(cycles).sort()) {
  console.log(`   ${cid}: ${count} fills`);
}

// Fix regime-state
const pos = state.position;
pos.cyclesCompleted = 10;

// Rebuild cycleBuys from cycle-11
const cycle11Buys = ledger.filter(f => f.cycleId === 'cycle-11' && f.side === 'buy' && !(f.isBodyOwned || f.isSatellite));
const uniqueBuyOrders = new Set(cycle11Buys.map(f => f.orderId));
pos.cycleBuys = uniqueBuyOrders.size;

console.log(`\n📊 State fixes:`);
console.log(`   cyclesCompleted: ${pos.cyclesCompleted}`);
console.log(`   cycleBuys: ${pos.cycleBuys} (${cycle11Buys.length} buy fills, ${uniqueBuyOrders.size} unique orders)`);

// Save
ledger.sort((a, b) => a.timestamp - b.timestamp);

const backupLedger = LEDGER_PATH + '.backup-fixcycle-' + Date.now();
fs.copyFileSync(LEDGER_PATH, backupLedger);
console.log(`\n💾 Backup: ${path.basename(backupLedger)}`);

fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
console.log('✅ fill-ledger.json saved');

fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
console.log('✅ regime-state.json saved');

// Verify
const c12 = ledger.filter(f => f.cycleId === 'cycle-12').length;
const c13 = ledger.filter(f => f.cycleId === 'cycle-13').length;
const c11 = ledger.filter(f => f.cycleId === 'cycle-11').length;
console.log(`\n🔍 Verification:`);
console.log(`   cycle-11 fills: ${c11}`);
console.log(`   cycle-12 fills: ${c12} ${c12 === 0 ? '✅' : '❌'}`);
console.log(`   cycle-13 fills: ${c13} ${c13 === 0 ? '✅' : '❌'}`);
console.log(`   cyclesCompleted: ${pos.cyclesCompleted} ${pos.cyclesCompleted === 10 ? '✅' : '❌'}`);
