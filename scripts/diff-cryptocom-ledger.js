#!/usr/bin/env node
/**
 * Diff exchange-trades.json against fill-ledger.json (by trade_id) to find
 * fills the engine missed. Prints summary + groups missing fills by order_id.
 *
 * Run after scripts/fetch-cryptocom-trades.js.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'cryptocom', 'CRO_USD');
const exchange = JSON.parse(fs.readFileSync(path.join(DIR, 'exchange-trades.json'), 'utf8'));
const ledger = JSON.parse(fs.readFileSync(path.join(DIR, 'fill-ledger.json'), 'utf8'));

const ledgerTradeIds = new Set(ledger.map(x => String(x.tradeId)));
const ledgerOrderIds = new Set(ledger.map(x => String(x.orderId)));

const missingFromLedger = exchange.filter(t => !ledgerTradeIds.has(String(t.trade_id)));
const exchangeTradeIds = new Set(exchange.map(t => String(t.trade_id)));
const ledgerNotOnExchange = ledger.filter(x =>
  !exchangeTradeIds.has(String(x.tradeId))
  && !String(x.tradeId).startsWith('dca-convert')  // synthetic DCA migration entries
);

const sumQty = (a, side, qtyKey) => a.filter(t => (t.side || t.toUpperCase?.()).toUpperCase() === side).reduce((s,t)=>s+Number(t[qtyKey]||t.size||0),0);
const sumUsd = (a, side) => a.filter(t => (t.side || '').toUpperCase() === side).reduce((s,t)=>s+Number(t.traded_quantity)*Number(t.traded_price),0);

console.log('=== Exchange vs Ledger reconciliation ===');
console.log(`exchange trades: ${exchange.length}`);
console.log(`ledger fills:    ${ledger.length}`);
console.log(`overlap (matching trade_id): ${exchange.length - missingFromLedger.length}`);
console.log(`missing from ledger (need to ingest): ${missingFromLedger.length}`);
console.log(`ledger fills not on exchange: ${ledgerNotOnExchange.length} (excluding dca-convert)`);

const mb = missingFromLedger.filter(t => t.side === 'BUY');
const ms = missingFromLedger.filter(t => t.side === 'SELL');
console.log(`\nmissing buys:  ${mb.length} fills, ${sumQty(missingFromLedger,'BUY','traded_quantity').toFixed(2)} CRO, $${sumUsd(missingFromLedger,'BUY').toFixed(2)}`);
console.log(`missing sells: ${ms.length} fills, ${sumQty(missingFromLedger,'SELL','traded_quantity').toFixed(2)} CRO, $${sumUsd(missingFromLedger,'SELL').toFixed(2)}`);

const groupByOid = (arr) => {
  const m = {};
  for (const t of arr) {
    const k = String(t.order_id);
    if (!m[k]) m[k] = [];
    m[k].push(t);
  }
  return Object.entries(m).map(([oid, fills]) => ({
    oid,
    inLedger: ledgerOrderIds.has(oid),
    count: fills.length,
    qty: fills.reduce((s,t)=>s+Number(t.traded_quantity),0),
    usd: fills.reduce((s,t)=>s+Number(t.traded_quantity)*Number(t.traded_price),0),
    side: fills[0].side,
    firstTs: Math.min(...fills.map(t=>Number(t.create_time))),
    lastTs: Math.max(...fills.map(t=>Number(t.create_time))),
  })).sort((a,b)=>b.qty-a.qty);
};

const sellGroups = groupByOid(ms);
const buyGroups = groupByOid(mb);

console.log('\n--- missing sells by order_id (sorted by qty) ---');
let cumSellQty = 0, cumSellUsd = 0;
for (const g of sellGroups.slice(0, 20)) {
  cumSellQty += g.qty; cumSellUsd += g.usd;
  console.log(`  ${g.oid} (${g.inLedger ? 'partial-known' : 'fully-orphan '}) ${g.count} fills | ${g.qty.toFixed(2)} CRO | $${g.usd.toFixed(2)} | ${new Date(g.firstTs).toISOString()}`);
}
if (sellGroups.length > 20) console.log(`  ... + ${sellGroups.length-20} more groups`);

console.log('\n--- missing buys by order_id (sorted by qty) ---');
for (const g of buyGroups.slice(0, 30)) {
  console.log(`  ${g.oid} (${g.inLedger ? 'partial-known' : 'fully-orphan '}) ${g.count} fills | ${g.qty.toFixed(2)} CRO | $${g.usd.toFixed(2)} | ${new Date(g.firstTs).toISOString()}`);
}
if (buyGroups.length > 30) console.log(`  ... + ${buyGroups.length-30} more groups`);

// Top-line: if we ingest these missing fills, what does it imply for state?
const totalLedgerBuy = ledger.filter(x=>x.side==='buy').reduce((s,x)=>s+x.size,0);
const totalLedgerSell = ledger.filter(x=>x.side==='sell').reduce((s,x)=>s+x.size,0);
const exchBuy = exchange.filter(t=>t.side==='BUY').reduce((s,t)=>s+Number(t.traded_quantity),0);
const exchSell = exchange.filter(t=>t.side==='SELL').reduce((s,t)=>s+Number(t.traded_quantity),0);

console.log('\n--- aggregate ---');
console.log(`ledger:   buys=${totalLedgerBuy.toFixed(2)} sells=${totalLedgerSell.toFixed(2)} net=${(totalLedgerBuy-totalLedgerSell).toFixed(2)}`);
console.log(`exchange: buys=${exchBuy.toFixed(2)} sells=${exchSell.toFixed(2)} net=${(exchBuy-exchSell).toFixed(2)}`);
console.log(`ledger excess net qty (phantom): ${((totalLedgerBuy-totalLedgerSell)-(exchBuy-exchSell)).toFixed(2)} CRO`);

// also: include the dca-convert synthetic entries in the ledger total
const dcaBuy = ledger.filter(x=>x.side==='buy' && String(x.tradeId).startsWith('dca-convert')).reduce((s,x)=>s+x.size,0);
console.log(`\nnote: ledger includes ${dcaBuy.toFixed(2)} CRO from synthetic dca-convert entries (DCA→regime migration backfill)`);

// Write missing-fills file for the ingestion script to consume
fs.writeFileSync(path.join(DIR, 'missing-fills.json'), JSON.stringify(missingFromLedger, null, 2));
console.log(`\nWrote ${missingFromLedger.length} missing fills to ${path.join(DIR, 'missing-fills.json')}`);
