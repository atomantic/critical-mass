#!/usr/bin/env node
/**
 * Targeted linking for orphan buy fills (no sellOrderId): attribute pre-TP
 * orphans to the black_hole body's TP order_id. The black_hole was the only
 * body active across the Feb–April timeframe and consolidated all CRO buys
 * into its position before its TP drained the body on 2026-05-10. Buys that
 * are missing sellOrderId but timestamped before that TP fill correspond to
 * CRO that ultimately got sold via this TP — they should be displayed under
 * that sell group, not as standalone orphans.
 *
 * Post-TP orphans (active cycle buys with no sell yet) are left as orphans —
 * that's correct: they're the live position waiting on the next TP.
 *
 * Idempotent — only touches buys with side='buy' AND no sellOrderId.
 * Engine MUST be stopped: pm2 stop critical-mass-cryptocom
 *
 * Usage:
 *   node scripts/cryptocom-link-buys-to-sells.js           # dry-run
 *   node scripts/cryptocom-link-buys-to-sells.js --apply   # writes
 */
const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD', 'fill-ledger.json');
const APPLY = process.argv.includes('--apply');

// Black_hole body's TP order_id and its body identity. The TP filled fully on
// 2026-05-10 16:10:09 UTC (113 partial fills, 483,593 CRO, $35,302 proceeds).
// State.celestialBodies.backup-fifo-* confirms this was body-85084389-mmtxp76q's
// active tpOrderId before the fill completion drained it.
const BLACK_HOLE_TP = '6142909974300226432';
const BLACK_HOLE_BODY_ID = 'body-85084389-mmtxp76q';
const BLACK_HOLE_BODY_TIER = 'black_hole';
const TP_FILL_END_MS = new Date('2026-05-10T16:10:10Z').getTime();

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));

let touched = 0;
let skippedActive = 0;
for (const f of ledger) {
  if (f.side !== 'buy') continue;
  if (f.sellOrderId) continue; // already linked
  if (f.timestamp >= TP_FILL_END_MS) { skippedActive++; continue; }
  f.sellOrderId = BLACK_HOLE_TP;
  f.bodyId = BLACK_HOLE_BODY_ID;
  f.bodyTier = BLACK_HOLE_BODY_TIER;
  f.isBodyOwned = true;
  touched++;
}

console.log(`Linked ${touched} pre-TP orphan buys to black_hole TP (${BLACK_HOLE_TP})`);
console.log(`Left ${skippedActive} post-TP orphans untouched (active position)`);

if (!APPLY) {
  console.log(`\nDry-run — pass --apply to write.`);
  process.exit(0);
}

const bp = `${LEDGER_PATH}.backup-link-${Date.now()}`;
fs.copyFileSync(LEDGER_PATH, bp);
console.log(`💾 Backup: ${path.basename(bp)}`);
fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
console.log(`✅ Wrote ledger with ${touched} new buy→sell links`);
