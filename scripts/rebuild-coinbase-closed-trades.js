#!/usr/bin/env node
/**
 * Rebuild coinbase BTC-USDC closed-trades.json from the cleaned fill ledger.
 * Replicates the body-grouping + prorated-cost-basis logic that
 * src/closed-trades.js migrateFromFills() uses, so the result matches what the
 * engine would produce on a fresh migration.
 *
 * Engine must be stopped. Backs up the existing closed-trades.json with a
 * timestamp suffix.
 *
 * Usage:
 *   node scripts/rebuild-coinbase-closed-trades.js          # dry-run
 *   node scripts/rebuild-coinbase-closed-trades.js --apply  # writes
 */

const fs = require('fs');
const path = require('path');

const apply = process.argv.includes('--apply');
const DIR = path.join(__dirname, '..', 'data', 'coinbase', 'BTC-USDC');
const LEDGER = path.join(DIR, 'fill-ledger.json');
const CLOSED = path.join(DIR, 'closed-trades.json');

const round8 = (n) => Math.round(n * 1e8) / 1e8;
const round2 = (n) => Math.round(n * 100) / 100;

const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const allFills = Array.isArray(raw) ? raw : Object.values(raw);

// Group buys + sells by bodyId; collect non-body sells with their linked buys.
const buysByBody = new Map();
const sellsByBody = new Map();
const sellsNoBody = [];
for (const f of allFills) {
  if (f.side === 'buy' && f.bodyId) {
    if (!buysByBody.has(f.bodyId)) buysByBody.set(f.bodyId, []);
    buysByBody.get(f.bodyId).push(f);
  } else if (f.side === 'sell') {
    if (f.bodyId) {
      if (!sellsByBody.has(f.bodyId)) sellsByBody.set(f.bodyId, []);
      sellsByBody.get(f.bodyId).push(f);
    } else {
      sellsNoBody.push(f);
    }
  }
}

const trades = [];
const dedup = new Set();
const recordTrade = (t) => {
  const key = `${t.sellOrderId}:${(t.qtySold || 0).toFixed(8)}`;
  if (dedup.has(key)) return;
  dedup.add(key);
  trades.push(t);
};

// Body-matched sells: prorate buy cost to sell quantity.
for (const [bodyId, sellFills] of sellsByBody) {
  const buyFills = buysByBody.get(bodyId) || [];
  const totalBuyQty = buyFills.reduce((s, b) => s + (Number(b.size) || 0), 0);
  const totalBuyCost = buyFills.reduce((s, b) => s + (Number(b.quoteAmount) || 0) + (Number(b.netFee) || 0), 0);
  const buyAvgPrice = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
  const buyOrderIds = [...new Set(buyFills.map(b => b.orderId))];

  // Aggregate sells by orderId
  const sellOrders = new Map();
  for (const s of sellFills) {
    const prev = sellOrders.get(s.orderId);
    const proceedsAdd = (Number(s.quoteAmount) || 0) - (Number(s.netFee) || 0);
    const feeAdd = Number(s.netFee) || 0;
    if (prev) {
      prev.qty += Number(s.size) || 0;
      prev.proceeds += proceedsAdd;
      prev.fees += feeAdd;
    } else {
      sellOrders.set(s.orderId, {
        qty: Number(s.size) || 0,
        proceeds: proceedsAdd,
        fees: feeAdd,
        timestamp: s.timestamp,
        tier: s.bodyTier,
        cycleId: s.cycleId,
        isPartial: s.partialFill || false,
        holdback: s.bodyHoldbackAsset || 0,
      });
    }
  }

  for (const [sellOrderId, sd] of sellOrders) {
    const costBasis = totalBuyQty > 0 ? round2((sd.qty / totalBuyQty) * totalBuyCost) : 0;
    const pnl = round2(sd.proceeds - costBasis);
    recordTrade({
      sellOrderId,
      timestamp: sd.timestamp,
      recordedAt: Date.now(),
      qtySold: sd.qty,
      sellProceeds: round2(sd.proceeds),
      sellFees: round2(sd.fees),
      costBasis,
      buyAvgPrice: round2(buyAvgPrice),
      pnl,
      holdbackAsset: 0,
      isPartial: sd.isPartial,
      bodyId,
      bodyTier: sd.tier || null,
      cycleId: sd.cycleId || null,
      buyOrderIds,
      source: 'migration',
    });
  }
}

// Non-body sells: match via sellOrderId linkage on buys.
const buysBySellId = new Map();
for (const f of allFills) {
  if (f.side === 'buy' && f.sellOrderId && !f.bodyId) {
    if (!buysBySellId.has(f.sellOrderId)) buysBySellId.set(f.sellOrderId, []);
    buysBySellId.get(f.sellOrderId).push(f);
  }
}

const noBodySellOrders = new Map();
for (const s of sellsNoBody) {
  const prev = noBodySellOrders.get(s.orderId);
  const proceedsAdd = (Number(s.quoteAmount) || 0) - (Number(s.netFee) || 0);
  const feeAdd = Number(s.netFee) || 0;
  if (prev) {
    prev.qty += Number(s.size) || 0;
    prev.proceeds += proceedsAdd;
    prev.fees += feeAdd;
  } else {
    noBodySellOrders.set(s.orderId, {
      qty: Number(s.size) || 0,
      proceeds: proceedsAdd,
      fees: feeAdd,
      timestamp: s.timestamp,
      cycleId: s.cycleId,
    });
  }
}

for (const [sellOrderId, sd] of noBodySellOrders) {
  const linked = buysBySellId.get(sellOrderId) || [];
  if (linked.length === 0) continue; // Can't compute without buys
  const buyCost = linked.reduce((s, b) => s + (Number(b.quoteAmount) || 0) + (Number(b.netFee) || 0), 0);
  const buyQty = linked.reduce((s, b) => s + (Number(b.size) || 0), 0);
  const costBasis = buyQty > 0 ? round2((sd.qty / buyQty) * buyCost) : 0;
  recordTrade({
    sellOrderId,
    timestamp: sd.timestamp,
    recordedAt: Date.now(),
    qtySold: sd.qty,
    sellProceeds: round2(sd.proceeds),
    sellFees: round2(sd.fees),
    costBasis,
    buyAvgPrice: buyQty > 0 ? round2(buyCost / buyQty) : 0,
    pnl: round2(sd.proceeds - costBasis),
    holdbackAsset: 0,
    isPartial: false,
    bodyId: null,
    bodyTier: null,
    cycleId: sd.cycleId || null,
    buyOrderIds: [...new Set(linked.map(b => b.orderId))],
    source: 'migration',
  });
}

trades.sort((a, b) => a.timestamp - b.timestamp);
const totalPnL = round2(trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0));

// Existing summary
let existingCount = 0, existingTotal = 0;
if (fs.existsSync(CLOSED)) {
  const ex = JSON.parse(fs.readFileSync(CLOSED, 'utf8'));
  const exArr = Array.isArray(ex) ? ex : (ex.trades || Object.values(ex));
  existingCount = exArr.length;
  existingTotal = round2(exArr.reduce((s, t) => s + (Number(t.pnl) || 0), 0));
}

console.log(`Coinbase BTC-USDC closed-trades rebuild`);
console.log(`  Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`  Existing: ${existingCount} trades, sum pnl $${existingTotal}`);
console.log(`  Rebuilt:  ${trades.length} trades, sum pnl $${totalPnL}`);

const sourceCounts = trades.reduce((m, t) => { m[t.source] = (m[t.source] || 0) + 1; return m; }, {});
console.log(`  By source:`, sourceCounts);

const negTrades = trades.filter(t => t.pnl < 0);
if (negTrades.length > 0) {
  console.log(`  WARNING: ${negTrades.length} rebuilt trades have negative pnl:`);
  for (const t of negTrades.slice(0, 10)) {
    console.log(`    ${t.sellOrderId.slice(0,8)} qty=${t.qtySold.toFixed(8)} proceeds=$${t.sellProceeds} cost=$${t.costBasis} pnl=$${t.pnl}`);
  }
}

if (apply) {
  if (fs.existsSync(CLOSED)) {
    const backup = `${CLOSED}.backup-rebuild-${Date.now()}`;
    fs.copyFileSync(CLOSED, backup);
    console.log(`  Backup: ${path.basename(backup)}`);
  }
  fs.writeFileSync(CLOSED, JSON.stringify(trades, null, 2));
  console.log(`  ✓ written`);
} else {
  console.log(`  (Re-run with --apply to write.)`);
}
