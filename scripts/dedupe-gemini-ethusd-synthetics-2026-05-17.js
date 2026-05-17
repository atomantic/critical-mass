#!/usr/bin/env node
/**
 * Dedupe synthetic-vs-real fill duplicates in Gemini ETHUSD fill-ledger.json.
 *
 * Context: the synthetic-fill fallback in handleOrderFill writes a row keyed
 * `synthetic-<orderId>` when getOrderFills returns empty. If real fills land
 * later via a different path (WS partial, reconciler), they get added without
 * removing the synthetic. Ledger dedup keys on tradeId — so both rows survive
 * and aggregateByOrderId in the dashboard doubles size/value.
 *
 * Worse: per-sell bodyPnl/bodyHoldbackAsset/bodyCostBasis annotations live
 * ONLY on synthetic rows. Real fills have bodyPnl=null. Because real rows
 * appear before synthetics in the array, aggregateByOrderId picks up the null
 * and the dashboard treats the sell as "no annotation" → recomputes from
 * linked buys → garbage P&L (-$14k/row in the screenshot).
 *
 * This script:
 *   1. Backs up fill-ledger.json
 *   2. For each orderId with BOTH synthetic and real rows:
 *      - Copies bodyPnl-family annotations (bodyPnl, bodyHoldbackAsset,
 *        bodyCostBasis, bodyAvgPrice, bodyBtcQty, bodyTier, satellitePnl,
 *        satelliteHoldbackAsset, isBodyOwned, isSatellite) from the
 *        synthetic onto the FIRST real fill of that orderId (in array order).
 *      - Removes the synthetic row.
 *   3. Leaves synthetic-only rows untouched (these represent real fills only
 *      ever ingested via the fallback path — no real twin exists).
 *   4. Validates: sum of bodyPnl (once per orderId) before == after.
 *
 * Engine must be stopped before --apply (script will refuse to run if a
 * regime-engine-running.json with recent timestamp exists, but the operator
 * should also confirm via pm2 list).
 *
 * Usage:
 *   node scripts/dedupe-gemini-ethusd-synthetics-2026-05-17.js          # dry-run
 *   node scripts/dedupe-gemini-ethusd-synthetics-2026-05-17.js --apply  # apply
 */

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.resolve(__dirname, '../data/gemini/ETHUSD/fill-ledger.json');
const APPLY = process.argv.includes('--apply');

const ANNOTATION_KEYS = [
  'bodyPnl',
  'bodyHoldbackAsset',
  'bodyCostBasis',
  'bodyAvgPrice',
  'bodyBtcQty',
  'bodyTier',
  'bodyId',
  'satellitePnl',
  'satelliteHoldbackAsset',
  'satelliteCostBasis',
  'satelliteAvgPrice',
  'satelliteBtcQty',
  'isBodyOwned',
  'isSatellite',
  'sellOrderId',
];

const isSyn = (f) => typeof f.tradeId === 'string' && f.tradeId.startsWith('synthetic-');

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
console.log(`Loaded ${ledger.length} fills from ${LEDGER_PATH}`);

const byOrderId = new Map();
ledger.forEach((f, idx) => {
  if (!byOrderId.has(f.orderId)) byOrderId.set(f.orderId, []);
  byOrderId.get(f.orderId).push({ idx, fill: f });
});

let twinsProcessed = 0;
let annotationsCopied = 0;
let syntheticsRemoved = 0;
const indicesToDelete = new Set();
const annotationLog = [];

for (const [orderId, rows] of byOrderId) {
  const syns = rows.filter((r) => isSyn(r.fill));
  const reals = rows.filter((r) => !isSyn(r.fill));
  if (syns.length === 0 || reals.length === 0) continue;
  twinsProcessed += 1;

  if (syns.length > 1) {
    console.warn(`⚠️ orderId ${orderId} has ${syns.length} synthetic rows — unexpected, keeping first only`);
  }

  const syn = syns[0].fill;
  const target = reals[0].fill;
  const before = {};
  const after = {};
  let copiedAny = false;

  for (const key of ANNOTATION_KEYS) {
    if (syn[key] == null) continue;
    before[key] = target[key];
    if (target[key] == null) {
      target[key] = syn[key];
      after[key] = syn[key];
      copiedAny = true;
      annotationsCopied += 1;
    } else if (target[key] !== syn[key] && key !== 'bodyTier') {
      // Existing real-row annotation differs from synthetic — keep real.
      console.warn(`  orderId ${orderId} key=${key}: real=${target[key]} syn=${syn[key]} — keeping real`);
    }
  }
  if (copiedAny) {
    annotationLog.push({ orderId, side: target.side, copied: Object.keys(after) });
  }

  for (const s of syns) {
    indicesToDelete.add(s.idx);
    syntheticsRemoved += 1;
  }
}

// Validate: sum of bodyPnl once per orderId, before vs after.
const sumBodyPnlOncePerOrder = (rows) => {
  const seen = new Map();
  for (const f of rows) {
    if (f.side !== 'sell') continue;
    if (f.bodyPnl == null) continue;
    if (!seen.has(f.orderId)) seen.set(f.orderId, f.bodyPnl);
  }
  let s = 0;
  for (const v of seen.values()) s += v;
  return { total: s, count: seen.size };
};

const sumHoldbackOncePerOrder = (rows) => {
  const seen = new Map();
  for (const f of rows) {
    if (f.side !== 'sell') continue;
    if (f.bodyHoldbackAsset == null) continue;
    if (!seen.has(f.orderId)) seen.set(f.orderId, f.bodyHoldbackAsset);
  }
  let s = 0;
  for (const v of seen.values()) s += v;
  return { total: s, count: seen.size };
};

const beforePnl = sumBodyPnlOncePerOrder(ledger);
const beforeHold = sumHoldbackOncePerOrder(ledger);

const newLedger = ledger.filter((_, idx) => !indicesToDelete.has(idx));

const afterPnl = sumBodyPnlOncePerOrder(newLedger);
const afterHold = sumHoldbackOncePerOrder(newLedger);

console.log('\n=== Summary ===');
console.log(`Orders with twin (syn+real): ${twinsProcessed}`);
console.log(`Annotations copied syn→real: ${annotationsCopied}`);
console.log(`Synthetic rows to remove:    ${syntheticsRemoved}`);
console.log(`Ledger size: ${ledger.length} → ${newLedger.length}`);
console.log(`\nbodyPnl sum (once-per-orderId):  before=$${beforePnl.total.toFixed(4)} (${beforePnl.count} sells)  after=$${afterPnl.total.toFixed(4)} (${afterPnl.count} sells)`);
console.log(`bodyHoldback sum (once-per-id):  before=${beforeHold.total.toFixed(8)} ETH  after=${afterHold.total.toFixed(8)} ETH`);

if (Math.abs(beforePnl.total - afterPnl.total) > 0.01) {
  console.error(`\n❌ bodyPnl sum diverged by $${(afterPnl.total - beforePnl.total).toFixed(4)} — aborting`);
  process.exit(1);
}
if (Math.abs(beforeHold.total - afterHold.total) > 1e-8) {
  console.error(`\n❌ holdback sum diverged by ${(afterHold.total - beforeHold.total).toFixed(8)} ETH — aborting`);
  process.exit(1);
}

if (afterPnl.count !== beforePnl.count) {
  console.error(`\n❌ sell-with-bodyPnl count changed: ${beforePnl.count} → ${afterPnl.count} — aborting`);
  process.exit(1);
}

console.log('\n✅ Validation passed: every sell still has its bodyPnl annotation on a surviving row.');

if (!APPLY) {
  console.log('\n(Dry run. Re-run with --apply to write changes.)');
  process.exit(0);
}

const backupPath = `${LEDGER_PATH}.backup-dedupe-synthetics-${Date.now()}`;
fs.copyFileSync(LEDGER_PATH, backupPath);
console.log(`\nBackup: ${backupPath}`);

fs.writeFileSync(LEDGER_PATH, JSON.stringify(newLedger, null, 2));
console.log(`Wrote ${newLedger.length} fills to ${LEDGER_PATH}`);
