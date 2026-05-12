#!/usr/bin/env node
/**
 * Remove the 1 BTC manual order triplet from coinbase BTC-USDC ledger.
 *
 * Three specific order_ids that were placed manually (not bot-managed):
 *   - 1d90f021-... : 1 BTC manual SELL on 2026-02-08
 *   - ccbca736-... : 1 BTC manual BUY on 2026-02-11 (~$68.9K)
 *   - d2147728-... : 1 BTC manual BUY on 2026-02-11 (~$69.0K)
 *
 * These fills got into the ledger but were never part of the bot's strategy.
 * Net effect on the ledger: −2 BTC buys, −1 BTC sell = −1 BTC net position
 * (the bot has 1 BTC less actually accumulated than the ledger claims).
 *
 * Preserved: the 3.30 BTC corrective pair (orderId starts with `634f981b`)
 * — that IS bot-managed cleanup of the auto-orphan incident.
 * See memory/project_coinbase_3btc_correction.md.
 *
 * Engine MUST be stopped (regime engine, not necessarily PM2 process).
 *
 * Usage:
 *   node scripts/coinbase-remove-manual-1btc.js           # dry-run
 *   node scripts/coinbase-remove-manual-1btc.js --apply   # writes
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'coinbase', 'BTC-USDC');
const LEDGER_PATH = path.join(DIR, 'fill-ledger.json');
const CLOSED_PATH = path.join(DIR, 'closed-trades.json');
const APPLY = process.argv.includes('--apply');

const REMOVE_PREFIXES = ['1d90f021', 'ccbca736', 'd2147728'];
const isManual = (oid) => REMOVE_PREFIXES.some(p => String(oid).startsWith(p));

const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
const closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));

const ledgerSurvivors = ledger.filter(f => !isManual(f.orderId));
const closedSurvivors = closed.filter(t => !isManual(t.sellOrderId));

const removedLedger = ledger.length - ledgerSurvivors.length;
const removedClosed = closed.length - closedSurvivors.length;

console.log(`fill-ledger.json:   ${ledger.length} → ${ledgerSurvivors.length} (−${removedLedger})`);
console.log(`closed-trades.json: ${closed.length} → ${closedSurvivors.length} (−${removedClosed})`);

const rmBuyQty = ledger.filter(f => isManual(f.orderId) && f.side === 'buy').reduce((s, f) => s + f.size, 0);
const rmSellQty = ledger.filter(f => isManual(f.orderId) && f.side === 'sell').reduce((s, f) => s + f.size, 0);
const rmBuyUsd = ledger.filter(f => isManual(f.orderId) && f.side === 'buy').reduce((s, f) => s + (f.quoteAmount || 0), 0);
const rmSellUsd = ledger.filter(f => isManual(f.orderId) && f.side === 'sell').reduce((s, f) => s + (f.quoteAmount || 0), 0);
console.log(`Removed: ${rmBuyQty.toFixed(8)} BTC of buys ($${rmBuyUsd.toFixed(2)}), ${rmSellQty.toFixed(8)} BTC of sells ($${rmSellUsd.toFixed(2)})`);
console.log(`Net qty change to ledger: ${(rmSellQty - rmBuyQty).toFixed(8)} BTC`);

// Sanity: corrective 3.30 BTC should be intact
const correctiveCount = ledgerSurvivors.filter(f => String(f.orderId).startsWith('634f981b')).length;
console.log(`Corrective 3.30 BTC fills (634f981b) preserved: ${correctiveCount}`);

if (!APPLY) {
  console.log('\nDry-run — pass --apply to write.');
  process.exit(0);
}

const bpL = `${LEDGER_PATH}.backup-manual-${Date.now()}`;
const bpC = `${CLOSED_PATH}.backup-manual-${Date.now()}`;
fs.copyFileSync(LEDGER_PATH, bpL);
fs.copyFileSync(CLOSED_PATH, bpC);
console.log(`💾 Backups: ${path.basename(bpL)}, ${path.basename(bpC)}`);
fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledgerSurvivors, null, 2));
fs.writeFileSync(CLOSED_PATH, JSON.stringify(closedSurvivors, null, 2));
console.log('✅ Wrote both files. Engine will derive fresh P&L from corrected ledger on next status fetch.');
