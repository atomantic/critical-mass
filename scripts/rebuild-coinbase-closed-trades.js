#!/usr/bin/env node
/**
 * Rebuild coinbase BTC-USDC closed-trades.json from the cleaned fill ledger.
 * Uses the cycle-pair annotations written to the ledger when available and
 * falls back to the same buy-linkage derivation used by the live ledger.
 *
 * Engine must be stopped. Backs up the existing closed-trades.json with a
 * timestamp suffix, but only after ledger coverage and realized-P&L checks
 * pass.
 *
 * Usage:
 *   node scripts/rebuild-coinbase-closed-trades.js          # dry-run
 *   node scripts/rebuild-coinbase-closed-trades.js --apply  # writes
 *
 * Tests and offline recovery can set CRITICAL_MASS_DATA_DIR to use a copied
 * data root without touching the repository's live data directory.
 */

const fs = require('fs');
const path = require('path');

const apply = process.argv.includes('--apply');
const DATA_ROOT = process.env.CRITICAL_MASS_DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_ROOT, 'coinbase', 'BTC-USDC');
const LEDGER = path.join(DIR, 'fill-ledger.json');
const CLOSED = path.join(DIR, 'closed-trades.json');
const STATE = path.join(DIR, 'regime-state.json');

const round8 = (n) => Math.round(n * 1e8) / 1e8;
const round2 = (n) => Math.round(n * 100) / 100;

const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const allFills = Array.isArray(raw) ? raw : Object.values(raw);

const buysByBody = new Map();
const buysBySellId = new Map();
const bodyBuySummary = new Map();
const sellOrders = new Map();

const numericAnnotation = (fill, primary, fallback) => {
  const value = fill[primary] ?? fill[fallback];
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value);
};

const applySellAnnotations = (target, fill) => {
  const annotations = [
    ['pnl', numericAnnotation(fill, 'bodyPnl', 'satellitePnl')],
    ['costBasis', numericAnnotation(fill, 'bodyCostBasis', 'satelliteCostBasis')],
    ['avgPrice', numericAnnotation(fill, 'bodyAvgPrice', 'satelliteAvgPrice')],
    ['holdback', numericAnnotation(fill, 'bodyHoldbackAsset', 'satelliteHoldbackAsset')],
  ];
  for (const [key, value] of annotations) {
    if (target[key] == null && value != null) target[key] = value;
  }
  if (target.bodyId == null) target.bodyId = fill.bodyId ?? null;
  if (target.tier == null) target.tier = fill.bodyTier ?? fill.satelliteTier ?? null;
  if (target.cycleId == null) target.cycleId = fill.cycleId ?? null;
  target.isPartial ||= Boolean(fill.partialFill);
};

const addBuy = (fill) => {
  if (fill.bodyId) {
    if (!buysByBody.has(fill.bodyId)) buysByBody.set(fill.bodyId, []);
    buysByBody.get(fill.bodyId).push(fill);
  }
  if (fill.sellOrderId) {
    if (!buysBySellId.has(fill.sellOrderId)) buysBySellId.set(fill.sellOrderId, []);
    buysBySellId.get(fill.sellOrderId).push(fill);
  }
};

const addSell = (fill) => {
  const previous = sellOrders.get(fill.orderId);
  const proceeds = (Number(fill.quoteAmount) || 0) - (Number(fill.netFee) || 0);
  const fees = Number(fill.netFee) || 0;
  const sell = previous || {
    qty: 0,
    proceeds: 0,
    fees: 0,
    timestamp: fill.timestamp,
    bodyId: fill.bodyId ?? null,
    tier: fill.bodyTier ?? fill.satelliteTier ?? null,
    cycleId: fill.cycleId ?? null,
    isPartial: Boolean(fill.partialFill),
    pnl: null,
    costBasis: null,
    avgPrice: null,
    holdback: null,
  };
  sell.qty += Number(fill.size) || 0;
  sell.proceeds += proceeds;
  sell.fees += fees;
  applySellAnnotations(sell, fill);
  sellOrders.set(fill.orderId, sell);
};

for (const fill of allFills) {
  if (fill.side === 'buy') addBuy(fill);
  else if (fill.side === 'sell') addSell(fill);
}

const summarizeBuys = (fills) => {
  const qty = fills.reduce((sum, fill) => sum + (Number(fill.size) || 0), 0);
  const cost = fills.reduce((sum, fill) => sum + (Number(fill.quoteAmount) || 0) + (Number(fill.netFee) || 0), 0);
  return {
    qty,
    cost,
    avgPrice: qty > 0 ? cost / qty : 0,
    orderIds: [...new Set(fills.map(fill => fill.orderId).filter(Boolean))],
  };
};

for (const [bodyId, buyFills] of buysByBody) bodyBuySummary.set(bodyId, summarizeBuys(buyFills));

const trades = [];
const dedup = new Set();
const recordTrade = (trade) => {
  const key = `${trade.sellOrderId}:${(trade.qtySold || 0).toFixed(8)}`;
  if (dedup.has(key)) return;
  dedup.add(key);
  trades.push(trade);
};

const expectedSellOrderIds = new Set();
for (const [sellOrderId, sell] of sellOrders) {
  const linkedBuys = buysBySellId.get(sellOrderId) || [];
  const linked = summarizeBuys(linkedBuys);
  const byBody = sell.bodyId ? bodyBuySummary.get(sell.bodyId) : null;

  // Server annotations are the cycle-pair source of truth. When they are
  // absent, prefer the explicit sellOrderId linkage used by the ledger; old
  // body rows fall back to the historical body-level prorated basis.
  const hasAnnotation = sell.pnl != null;
  const canUseLinkage = linkedBuys.length > 0;
  const canUseBodyFallback = Boolean(byBody);
  if (!hasAnnotation && !canUseLinkage && !canUseBodyFallback) continue;

  expectedSellOrderIds.add(sellOrderId);
  const costBasis = sell.costBasis != null
    ? round2(sell.costBasis)
    : canUseLinkage
      ? round2(linked.cost)
      : canUseBodyFallback && byBody.qty > 0
        ? round2((sell.qty / byBody.qty) * byBody.cost)
        : 0;
  const buyAvgPrice = sell.avgPrice != null
    ? round2(sell.avgPrice)
    : canUseLinkage
      ? round2(linked.avgPrice)
      : round2(byBody?.avgPrice || 0);
  const buyOrderIds = linked.orderIds.length > 0 ? linked.orderIds : (byBody?.orderIds || []);
  // Keep the source P&L precision so summing the rebuilt audit rows rounds to
  // the cycle-pair total; rounding every row to cents can lose a cent across
  // hundreds of fills and make the dashboard disagree with regime-state.
  const pnl = sell.pnl != null
    ? round8(sell.pnl)
    : canUseLinkage
      ? round8(sell.proceeds - linked.cost)
      : round8(sell.proceeds - costBasis);

  recordTrade({
    sellOrderId,
    timestamp: sell.timestamp,
    recordedAt: Date.now(),
    qtySold: sell.qty,
    sellProceeds: round2(sell.proceeds),
    sellFees: round2(sell.fees),
    costBasis,
    buyAvgPrice,
    pnl,
    holdbackAsset: sell.holdback != null ? round8(sell.holdback) : 0,
    isPartial: sell.isPartial,
    bodyId: sell.bodyId,
    bodyTier: sell.tier,
    cycleId: sell.cycleId,
    buyOrderIds,
    source: 'migration',
  });
}

trades.sort((a, b) => a.timestamp - b.timestamp);
const totalPnL = round2(trades.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0));

const verificationErrors = [];
const rebuiltOrderIds = new Set(trades.map(trade => trade.sellOrderId));
for (const sellOrderId of expectedSellOrderIds) {
  if (sellOrderId && !rebuiltOrderIds.has(sellOrderId)) verificationErrors.push(`missing closed sell order ${sellOrderId}`);
}

let expectedRealizedPnL = null;
if (!fs.existsSync(STATE)) {
  verificationErrors.push('regime-state.json is missing');
} else {
  try {
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    expectedRealizedPnL = Number(state.position?.realizedPnL);
    if (!Number.isFinite(expectedRealizedPnL)) verificationErrors.push('regime-state.json has no finite position.realizedPnL');
    else if (Math.abs(totalPnL - expectedRealizedPnL) > 0.01) {
      verificationErrors.push(`rebuilt P&L $${totalPnL.toFixed(2)} does not match regime-state P&L $${expectedRealizedPnL.toFixed(2)}`);
    }
  } catch (error) {
    verificationErrors.push(`regime-state.json is unreadable: ${error.message}`);
  }
}

let existingCount = 0;
let existingTotal = 0;
if (fs.existsSync(CLOSED)) {
  const existing = JSON.parse(fs.readFileSync(CLOSED, 'utf8'));
  const existingTrades = Array.isArray(existing) ? existing : (existing.trades || Object.values(existing));
  existingCount = existingTrades.length;
  existingTotal = round2(existingTrades.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0));
}

console.log('Coinbase BTC-USDC closed-trades rebuild');
console.log(`  Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`  Existing: ${existingCount} trades, sum pnl $${existingTotal}`);
console.log(`  Rebuilt:  ${trades.length} trades, sum pnl $${totalPnL}`);
if (expectedRealizedPnL != null && verificationErrors.length === 0) {
  console.log(`  Verified: ${trades.length} rebuilt trades cover every closed sell and match regime-state P&L $${expectedRealizedPnL.toFixed(2)}`);
}

const sourceCounts = trades.reduce((counts, trade) => {
  counts[trade.source] = (counts[trade.source] || 0) + 1;
  return counts;
}, {});
console.log('  By source:', sourceCounts);

const negativeTrades = trades.filter(trade => trade.pnl < 0);
if (negativeTrades.length > 0) {
  console.log(`  WARNING: ${negativeTrades.length} rebuilt trades have negative pnl:`);
  for (const trade of negativeTrades.slice(0, 10)) {
    console.log(`    ${String(trade.sellOrderId).slice(0, 8)} qty=${trade.qtySold.toFixed(8)} proceeds=$${trade.sellProceeds} cost=$${trade.costBasis} pnl=$${trade.pnl}`);
  }
}

if (verificationErrors.length > 0) {
  console.error(`  ✗ Verification failed: ${verificationErrors.join('; ')}`);
  console.error('  No file was written. Resolve the ledger/state mismatch before restarting the engine.');
  process.exitCode = 1;
} else if (apply) {
  if (fs.existsSync(CLOSED)) {
    const backup = `${CLOSED}.backup-rebuild-${Date.now()}`;
    fs.copyFileSync(CLOSED, backup);
    console.log(`  Backup: ${path.basename(backup)}`);
  }
  fs.writeFileSync(CLOSED, JSON.stringify(trades, null, 2));
  console.log('  ✓ written');
} else {
  console.log('  (Re-run with --apply to write.)');
}
